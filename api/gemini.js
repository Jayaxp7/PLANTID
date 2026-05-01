export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Proteção de origem — só aceita chamadas do próprio domínio
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const allowed = [
        'https://plantid.com.br',
        'https://www.plantid.com.br',
        'https://plantid-alpha.vercel.app',
    ];

    const originOk = allowed.some(a => origin.startsWith(a) || referer.startsWith(a));

    // Em desenvolvimento local (sem origin) também permite
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
        return res.status(response.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
