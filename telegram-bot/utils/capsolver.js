import fetch from 'node-fetch';

const API_KEY = process.env.CAPSOLVER_API_KEY || 'CAP-839F56FE8BBE99EF5F4C07E062A2A7349B07B4DD64ED6E6F483A194EA10091D1';

async function createTask(payload) {
    try {
        const response = await fetch('https://api.capsolver.com/createTask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                clientKey: API_KEY,
                task: payload
            })
        });
        return await response.json();
    } catch (error) {
        console.error('Capsolver createTask error:', error);
        return { error: error.message, errorId: 1 };
    }
}

async function getTaskResult(taskId) {
    try {
        const response = await fetch('https://api.capsolver.com/getTaskResult', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                clientKey: API_KEY,
                taskId: taskId
            })
        });
        return await response.json();
    } catch (error) {
        console.error('Capsolver getTaskResult error:', error);
        return { error: error.message, errorId: 1 };
    }
}

/**
 * Solves ReCaptchaV2
 * @param {string} websiteURL 
 * @param {string} websiteKey 
 * @param {object} enterprisePayload Optional extra payload
 * @returns {Promise<string>} The captcha token
 */
export async function solveRecaptchaV2(websiteURL, websiteKey, enterprisePayload = {}) {
    const taskPayload = {
        type: 'ReCaptchaV2EnterpriseTaskProxyLess',
        websiteURL: websiteURL,
        websiteKey: websiteKey,
        enterprisePayload: enterprisePayload
    };

    const createResult = await createTask(taskPayload);

    if (createResult.errorId !== 0) {
        throw new Error(`Capsolver create task failed: ${createResult.errorDescription || JSON.stringify(createResult)}`);
    }

    const taskId = createResult.taskId;
    let status = 'processing';
    let count = 0;

    // Wait for the result
    while (status === 'processing' && count < 60) { // Timeout after ~2 minutes
        await new Promise(r => setTimeout(r, 2000));
        const result = await getTaskResult(taskId);

        if (result.errorId !== 0) {
            throw new Error(`Capsolver get result failed: ${result.errorDescription}`);
        }

        status = result.status;
        if (status === 'ready') {
            return result.solution.gRecaptchaResponse;
        }
        count++;
    }

    throw new Error('Capsolver timeout');
}
