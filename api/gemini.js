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

        // Salvar usageMetadata via Firestore REST API (sem firebase-admin)
        if (response.ok && data.usageMetadata) {
            try {
                const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                const projectId = serviceAccount.project_id;
                const usage = data.usageMetadata;

                const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/uso_tokens`;

                // Gerar token OAuth2 com JWT
                const now = Math.floor(Date.now() / 1000);
                const header = { alg: 'RS256', typ: 'JWT' };
                const payload = {
                    iss: serviceAccount.client_email,
                    scope: 'https://www.googleapis.com/auth/datastore',
                    aud: 'https://oauth2.googleapis.com/token',
                    iat: now,
                    exp: now + 3600,
                };

                const encode = obj => btoa(JSON.stringify(obj))
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

                const signingInput = `${encode(header)}.${encode(payload)}`;

                // Importar crypto para assinar com RS256
                const privateKey = serviceAccount.private_key;
                const keyData = privateKey
                    .replace('-----BEGIN PRIVATE KEY-----', '')
                    .replace('-----END PRIVATE KEY-----', '')
                    .replace(/\n/g, '');

                const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
                const cryptoKey = await crypto.subtle.importKey(
                    'pkcs8', binaryKey,
                    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                    false, ['sign']
                );

                const encoder = new TextEncoder();
                const signature = await crypto.subtle.sign(
                    'RSASSA-PKCS1-v1_5',
                    cryptoKey,
                    encoder.encode(signingInput)
                );

                const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

                const jwt = `${signingInput}.${sigB64}`;

                // Trocar JWT por access token
                const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
                });
                const tokenData = await tokenResp.json();
                const accessToken = tokenData.access_token;

                // Salvar no Firestore
                await fetch(firestoreUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`
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

            } catch (fbErr) {
                // Falha silenciosa — não bloqueia a resposta ao usuário
                console.error('Firestore usage log error:', fbErr.message);
            }
        }

        return res.status(response.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
