const { Ollama } = require('ollama');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');

let onTranscriptionComplete = null;

// ── State ──
let ollamaClient = null;
let ollamaModel = null;
let whisperPipeline = null;
let isWhisperLoading = false;
let localConversationHistory = [];
let currentSystemPrompt = null;
let isLocalActive = false;

// VAD state
let isSpeaking = false;
let speechBuffers = [];
let silenceFrameCount = 0;
let speechFrameCount = 0;

// VAD configuration
const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 },
};
let vadConfig = VAD_MODES.VERY_AGGRESSIVE;

// Audio resampling buffer
let resampleRemainder = Buffer.alloc(0);

// ── Audio Resampling (24kHz → 16kHz) ──
function resample24kTo16k(inputBuffer) {
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const srcPos = (i * 3) / 2;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;
        const s0 = combined.readInt16LE(srcIndex * 2);
        const s1 = srcIndex + 1 < inputSamples ? combined.readInt16LE((srcIndex + 1) * 2) : s0;
        const interpolated = Math.round(s0 + frac * (s1 - s0));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);
    return outputBuffer;
}

// ── VAD (Voice Activity Detection) ──
function calculateRMS(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
}

function processVAD(pcm16kBuffer) {
    const rms = calculateRMS(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        speechFrameCount++;
        silenceFrameCount = 0;
        if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
            isSpeaking = true;
            speechBuffers = [];
            console.log('[LocalAI] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount++;
        speechFrameCount = 0;
        if (isSpeaking && silenceFrameCount >= vadConfig.silenceFramesRequired) {
            isSpeaking = false;
            console.log('[LocalAI] Speech ended, accumulated', speechBuffers.length, 'chunks');
            sendToRenderer('update-status', 'Transcribing...');
            const audioData = Buffer.concat(speechBuffers);
            speechBuffers = [];
            handleSpeechEnd(audioData);
            return;
        }
    }

    if (isSpeaking) {
        speechBuffers.push(Buffer.from(pcm16kBuffer));
    }
}

// ── Whisper Transcription ──
async function loadWhisperPipeline(modelName) {
    if (whisperPipeline) return whisperPipeline;
    if (isWhisperLoading) {
        console.log('[LocalAI] Whisper model already loading, waiting...');
        return null;
    }

    isWhisperLoading = true;
    console.log('[LocalAI] Loading Whisper model:', modelName);
    sendToRenderer('whisper-downloading', true);
    sendToRenderer('update-status', 'Loading Whisper model (first time may take a while)...');

    try {
        const mem = process.memoryUsage();
        const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
        console.log('[LocalAI] Memory before model load:', heapUsedMB, 'MB used,', heapTotalMB, 'MB total, arch:', process.arch);
        if (process.arch === 'ia32' && heapTotalMB > 1024) {
            console.warn('[LocalAI] Low memory environment detected, model may fail');
            sendToRenderer('update-status', 'Warning: Low memory, model may not load');
        }
    } catch (memError) {
        console.warn('[LocalAI] Memory check failed:', memError);
    }

    function clearModelCache(cacheDir, modelName) {
        try {
            const fs = require('fs');
            const path = require('path');
            const modelCachePath = path.join(cacheDir, ...modelName.split('/'));
            if (fs.existsSync(modelCachePath)) {
                fs.rmSync(modelCachePath, { recursive: true, force: true });
                console.log('[LocalAI] Cleared corrupted cache at:', modelCachePath);
                return true;
            } else {
                console.warn('[LocalAI] Cache path not found:', modelCachePath);
                return false;
            }
        } catch (e) {
            console.error('[LocalAI] Failed to clear cache:', e.message);
            return false;
        }
    }

    let pipelineFn = null;
    let cacheDir = null;

    try {
        console.log('[LocalAI] Importing @huggingface/transformers...');
        const { pipeline, env } = await import('@huggingface/transformers');

        const { app } = require('electron');
        const path = require('path');
        cacheDir = path.join(app.getPath('userData'), 'whisper-models');
        env.cacheDir = cacheDir;
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        env.usePaddleBackend = false;

        pipelineFn = pipeline;

        console.log('[LocalAI] Creating Whisper pipeline with model:', modelName, 'on CPU (q8)...');
        whisperPipeline = await pipeline('automatic-speech-recognition', modelName, {
            dtype: 'q8',
            device: 'cpu',
        });

        console.log('[LocalAI] Whisper model loaded successfully');
        sendToRenderer('whisper-downloading', false);
        isWhisperLoading = false;
        return whisperPipeline;

    } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        const isProtobufError =
            errorMessage.includes('Protobuf parsing failed') ||
            errorMessage.includes('corrupted') ||
            errorMessage.includes('onnx');

        console.error('[LocalAI] Failed to load Whisper model:', errorMessage);

        if (isProtobufError && pipelineFn && cacheDir) {
            console.warn('[LocalAI] Corrupted model detected, clearing cache and retrying...');
            sendToRenderer('update-status', 'Corrupted model cache found, re-downloading...');
            clearModelCache(cacheDir, modelName);

            try {
                whisperPipeline = await pipelineFn('automatic-speech-recognition', modelName, {
                    dtype: 'q8',
                    device: 'cpu',
                });
                console.log('[LocalAI] Whisper model loaded successfully on retry');
                sendToRenderer('whisper-downloading', false);
                isWhisperLoading = false;
                return whisperPipeline;
            } catch (retryError) {
                console.error('[LocalAI] Retry also failed:', retryError.message || retryError);
                isWhisperLoading = false;
                sendToRenderer('whisper-downloading', false);
                sendToRenderer('update-status', 'Failed to re-download Whisper model. Try switching to whisper-tiny in settings.');
                return null;
            }
        }

        sendToRenderer('whisper-downloading', false);
        sendToRenderer('update-status', 'Failed to load Whisper model: ' + errorMessage);
        isWhisperLoading = false;
        return null;
    }
}

function pcm16ToFloat32(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    const float32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        float32[i] = pcm16Buffer.readInt16LE(i * 2) / 32768;
    }
    return float32;
}

async function transcribeAudio(pcm16kBuffer) {
    if (!whisperPipeline) {
        console.error('[LocalAI] Whisper pipeline not loaded');
        return null;
    }
    try {
        const float32Audio = pcm16ToFloat32(pcm16kBuffer);
        const result = await whisperPipeline(float32Audio, {
            sampling_rate: 16000,
            language: 'en',
            task: 'transcribe',
        });
        const text = result.text?.trim();
        console.log('[LocalAI] Transcription:', text);
        return text;
    } catch (error) {
        console.error('[LocalAI] Transcription error:', error);
        return null;
    }
}

function setTranscriptionCallback(callback) {
    onTranscriptionComplete = callback;
}

// ── Speech End Handler ──
async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;
    if (audioData.length < 16000) {
        console.log('[LocalAI] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    const transcription = await transcribeAudio(audioData);
    if (!transcription || transcription.trim() === '' || transcription.trim().length < 2) {
        console.log('[LocalAI] Empty transcription, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    sendToRenderer('update-status', 'Generating response...');
    if (onTranscriptionComplete) {
        await onTranscriptionComplete(transcription);
    } else {
        await sendToOllama(transcription);
    }
}

// ── Ollama Chat ──
async function sendToOllama(transcription) {
    if (!ollamaClient || !ollamaModel) {
        console.error('[LocalAI] Ollama not configured');
        return;
    }

    console.log('[LocalAI] Sending to Ollama:', transcription.substring(0, 100) + '...');
    localConversationHistory.push({ role: 'user', content: transcription.trim() });
    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory,
        ];

        const response = await ollamaClient.chat({ model: ollamaModel, messages, stream: true });
        let fullText = '';
        let isFirst = true;

        for await (const part of response) {
            const token = part.message?.content || '';
            if (token) {
                fullText += token;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(transcription, fullText);
        }

        console.log('[LocalAI] Ollama response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[LocalAI] Ollama error:', error);
        sendToRenderer('update-status', 'Ollama error: ' + error.message);
    }
}

// ── Public API ──
async function initializeLocalSession(ollamaHost, model, whisperModel, profile, customPrompt) {
    console.log('[LocalAI] Initializing local session:', { ollamaHost, model, whisperModel, profile });
    sendToRenderer('session-initializing', true);

    try {
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        ollamaClient = new Ollama({ host: ollamaHost });
        ollamaModel = model;

        try {
            await ollamaClient.list();
            console.log('[LocalAI] Ollama connection verified');
        } catch (error) {
            console.error('[LocalAI] Cannot connect to Ollama at', ollamaHost, ':', error.message);
            sendToRenderer('session-initializing', false);
            sendToRenderer('update-status', 'Cannot connect to Ollama at ' + ollamaHost);
            return false;
        }

        const pipeline = await loadWhisperPipeline(whisperModel);
        if (!pipeline) {
            sendToRenderer('session-initializing', false);
            return false;
        }

        isSpeaking = false;
        speechBuffers = [];
        silenceFrameCount = 0;
        speechFrameCount = 0;
        resampleRemainder = Buffer.alloc(0);
        localConversationHistory = [];

        initializeNewSession(profile, customPrompt);
        isLocalActive = true;
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI ready - Listening...');
        console.log('[LocalAI] Session initialized successfully');
        return true;
    } catch (error) {
        console.error('[LocalAI] Initialization error:', error);
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        return false;
    }
}

function processLocalAudio(monoChunk24k) {
    if (!isLocalActive) return;
    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length > 0) {
        processVAD(pcm16k);
    }
}

function closeLocalSession() {
    console.log('[LocalAI] Closing local session');
    isLocalActive = false;
    resetVadState();
    localConversationHistory = [];
    ollamaClient = null;
    ollamaModel = null;
    currentSystemPrompt = null;
}

function resetVadState() {
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
}

function isLocalSessionActive() {
    return isLocalActive;
}

function setLocalActive(active) {
    isLocalActive = active;
}

async function sendLocalText(text) {
    if (!isLocalActive || !ollamaClient) {
        return { success: false, error: 'No active local session' };
    }
    try {
        await sendToOllama(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive || !ollamaClient) {
        return { success: false, error: 'No active local session' };
    }
    try {
        console.log('[LocalAI] Sending image to Ollama');
        sendToRenderer('update-status', 'Analyzing image...');

        const userMessage = { role: 'user', content: prompt, images: [base64Data] };
        localConversationHistory.push({ role: 'user', content: prompt });
        if (localConversationHistory.length > 20) {
            localConversationHistory = localConversationHistory.slice(-20);
        }

        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory.slice(0, -1),
            userMessage,
        ];

        const response = await ollamaClient.chat({ model: ollamaModel, messages, stream: true });
        let fullText = '';
        let isFirst = true;

        for await (const part of response) {
            const token = part.message?.content || '';
            if (token) {
                fullText += token;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(prompt, fullText);
        }

        console.log('[LocalAI] Image response completed');
        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: ollamaModel };
    } catch (error) {
        console.error('[LocalAI] Image error:', error);
        sendToRenderer('update-status', 'Ollama error: ' + error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeLocalSession,
    processLocalAudio,
    closeLocalSession,
    resetVadState,
    isLocalSessionActive,
    setLocalActive,
    sendLocalText,
    sendLocalImage,
    setTranscriptionCallback,
    loadWhisperPipeline,
};