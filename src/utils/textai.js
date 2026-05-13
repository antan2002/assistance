const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

let conversationHistory = [];
let currentSystemPrompt = null;
let isActive = false;
let currentProvider = null;
let currentModel = null;

function closeSession() {
    isActive = false;
    conversationHistory = [];
    currentSystemPrompt = null;
    currentProvider = null;
    currentModel = null;
}

function isActiveSession() {
    return isActive;
}

async function initSession(provider, apiKey, model, profile, customPrompt) {
    currentProvider = provider;
    currentModel = model;
    currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
    conversationHistory = [];
    initializeNewSession(profile, customPrompt);
    isActive = true;
    sendToRenderer('update-status', `${provider} ready - Listening...`);
    return true;
}

function buildRequestBody(messages, model) {
    switch (currentProvider) {
        case 'openrouter':
            return {
                model: model,
                messages: messages,
                stream: true,
            };
        case 'claude':
            return {
                model: model || 'claude-3-haiku-20240307',
                messages: messages.slice(1),
                system: messages[0].content,
                stream: true,
                max_tokens: 4096,
            };
        case 'openai':
            return {
                model: model || 'gpt-4o-mini',
                messages: messages,
                stream: true,
            };
        case 'deepseek':
            return {
                model: model || 'deepseek-chat',
                messages: messages,
                stream: true,
            };
        case 'opencode':
            return {
                model: model || 'opencode/big-pickle',
                messages: messages,
                stream: true,
            };
        default:
            return { model, messages, stream: true };
    }
}

function getApiEndpoint() {
    switch (currentProvider) {
        case 'openrouter': return `${OPENROUTER_API_BASE}/chat/completions`;
        case 'claude': return 'https://api.anthropic.com/v1/messages';
        case 'openai': return 'https://api.openai.com/v1/chat/completions';
        case 'deepseek': return 'https://api.deepseek.com/v1/chat/completions';
        case 'opencode': return 'https://opencode.ai/zen/v1/chat/completions';
        default: return '';
    }
}

function getApiHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    switch (currentProvider) {
        case 'openrouter':
            headers['Authorization'] = `Bearer ${apiKey}`;
            headers['HTTP-Referer'] = 'https://github.com/antan2002/assistance';
            headers['X-Title'] = 'Assistance';
            break;
        case 'claude':
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            break;
        case 'openai':
            headers['Authorization'] = `Bearer ${apiKey}`;
            break;
        case 'deepseek':
            headers['Authorization'] = `Bearer ${apiKey}`;
            break;
        case 'opencode':
            headers['Authorization'] = `Bearer ${apiKey}`;
            break;
    }
    return headers;
}

async function sendText(transcription, apiKey) {
    if (!isActive || !currentProvider) {
        return { success: false, error: 'No active session' };
    }

    conversationHistory.push({ role: 'user', content: transcription.trim() });

    if (conversationHistory.length > 20) {
        conversationHistory = conversationHistory.slice(-20);
    }

    const messages = [
        { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
        ...conversationHistory,
    ];

    try {
        const body = buildRequestBody(messages, currentModel);
        const endpoint = getApiEndpoint();
        const headers = getApiHeaders(apiKey);

        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`${currentProvider} API error (${response.status}): ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let isFirst = true;
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    let token = '';
                    if (currentProvider === 'claude') {
                        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                            token = parsed.delta.text;
                        }
                    } else {
                        token = parsed.choices?.[0]?.delta?.content || '';
                    }
                    if (token) {
                        fullText += token;
                        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                        isFirst = false;
                    }
                } catch (e) {
                    // skip parse errors
                }
            }
        }

        if (fullText.trim()) {
            conversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(transcription, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText };
    } catch (error) {
        sendToRenderer('update-status', `${currentProvider} error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function sendImage(base64Data, prompt, apiKey) {
    if (!isActive || !currentProvider) {
        return { success: false, error: 'No active session' };
    }

    try {
        sendToRenderer('update-status', 'Analyzing image...');

        const userContent = [];
        if (currentProvider === 'openrouter') {
            userContent.push({ type: 'text', text: prompt });
            userContent.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${base64Data}` },
            });
        } else {
            userContent.push({ type: 'text', text: prompt });
            userContent.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${base64Data}` },
            });
        }

        conversationHistory.push({ role: 'user', content: prompt });

        if (conversationHistory.length > 20) {
            conversationHistory = conversationHistory.slice(-20);
        }

        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...conversationHistory.slice(0, -1),
            { role: 'user', content: userContent },
        ];

        const body = buildRequestBody(messages, currentModel);
        if (currentProvider === 'claude') {
            body.messages = messages.slice(1);
            body.system = messages[0].content;
        }

        const endpoint = getApiEndpoint();
        const headers = getApiHeaders(apiKey);

        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`${currentProvider} API error (${response.status}): ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let isFirst = true;
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    let token = '';
                    if (currentProvider === 'claude') {
                        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                            token = parsed.delta.text;
                        }
                    } else {
                        token = parsed.choices?.[0]?.delta?.content || '';
                    }
                    if (token) {
                        fullText += token;
                        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                        isFirst = false;
                    }
                } catch (e) {
                    // skip
                }
            }
        }

        if (fullText.trim()) {
            conversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(prompt, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: currentModel };
    } catch (error) {
        sendToRenderer('update-status', `${currentProvider} error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initSession,
    sendText,
    sendImage,
    closeSession,
    isActiveSession,
};
