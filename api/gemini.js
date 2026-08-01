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
        const modelName = model || 'gemini-3.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;

        const body = { contents };
        if (system_instruction) body.system_instruction = system_instruction;
        if (generationConfig) body.generationConfig = generationConfig;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        // Log de tokens — nunca bloqueia nem quebra a resposta
        if (response.ok && data?.usageMetadata && process.env.FIREBASE_SERVICE_ACCOUNT) {
            await logTokens(data.usageMetadata, modelName).catch(() => {});
        }

        return res.status(response.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}

// ─── LOG DE TOKENS NO FIRESTORE (REST API, sem dependências) ────────────────

// Cache do access token entre invocações quentes (evita OAuth a cada chamada)
let _tokenCache = { token: null, exp: 0 };

async function getAccessToken(serviceAccount) {
    const agora = Math.floor(Date.now() / 1000);
    if (_tokenCache.token && _tokenCache.exp > agora + 60) {
        return _tokenCache.token;
    }

    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss:   serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud:   'https://oauth2.googleapis.com/token',
        iat:   agora,
        exp:   agora + 3600,
    })).toString('base64url');

    const signingInput = `${header}.${payload}`;

    const { createSign } = await import('node:crypto');
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(serviceAccount.private_key, 'base64url');

    const jwt = `${signingInput}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        }).toString()
    });

    const json = await resp.json();
    if (!json.access_token) throw new Error('Falha ao obter access_token');

    _tokenCache = { token: json.access_token, exp: agora + 3500 };
    return json.access_token;
}

async function logTokens(usage, modelName) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const projectId      = serviceAccount.project_id;
    const accessToken    = await getAccessToken(serviceAccount);

    await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/uso_tokens`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                fields: {
                    promptTokens:    { integerValue: String(usage.promptTokenCount     ?? 0) },
                    candidateTokens: { integerValue: String(usage.candidatesTokenCount ?? 0) },
                    totalTokens:     { integerValue: String(usage.totalTokenCount      ?? 0) },
                    modelo:          { stringValue: modelName },
                    timestamp:       { timestampValue: new Date().toISOString() },
                }
            })
        }
    );
}
