export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const allowed = [
        'https://plantid.com.br',
        'https://www.plantid.com.br',
        'https://plantid-alpha.vercel.app',
    ];

    const originOk = allowed.some(a => origin.startsWith(a) || referer.startsWith(a));
    const isLocal = !origin && !referer;

    if (!originOk && !isLocal) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        return res.status(500).json({ error: 'Chave não configurada' });
    }

    try {
        const { model, contents, system_instruction, generationConfig } = req.body;
        const modelName = model || 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${API_KEY}`;

        const body = { contents };
        if (system_instruction) body.system_instruction = system_instruction;
        if (generationConfig) body.generationConfig = generationConfig;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        // Log de tokens — falha silenciosa, não bloqueia resposta
        if (response.ok && data.usageMetadata && process.env.FIREBASE_SERVICE_ACCOUNT) {
            logTokens(data.usageMetadata, modelName).catch(() => {});
        }

        return res.status(response.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}

async function logTokens(usage, modelName) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const projectId = serviceAccount.project_id;

    // Gerar JWT para autenticação
    const now = Math.floor(Date.now() / 1000);
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    })).toString('base64url');

    const signingInput = `${headerB64}.${payloadB64}`;

    const { createSign } = await import('crypto');
    const sign = createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(serviceAccount.private_key, 'base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const jwt = `${signingInput}.${signature}`;

    // Trocar JWT por access token
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    const { access_token } = await tokenResp.json();

    // Salvar no Firestore via REST
    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/uso_tokens`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${access_token}`
        },
        body: JSON.stringify({
            fields: {
                promptTokens:    { integerValue: usage.promptTokenCount     ?? 0 },
                candidateTokens: { integerValue: usage.candidatesTokenCount ?? 0 },
                totalTokens:     { integerValue: usage.totalTokenCount      ?? 0 },
                modelo:          { stringValue: modelName },
                timestamp:       { timestampValue: new Date().toISOString() },
            }
        })
    });
}
