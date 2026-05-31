import { getState, saveState } from './_state.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { playerId, username } = req.body;
    if (!playerId) {
        return res.status(400).json({ error: 'Player ID required' });
    }

    const state = await getState(playerId);

    if (!state.db[playerId]) {
        state.db[playerId] = {
            id: playerId,
            username: username || 'Commander ' + Math.floor(1000 + Math.random() * 9000),
            stats: {
                territoriesAnnexed: 0,
                peakMilitary: 0,
                wins: 0,
                survived: 0
            },
            tokens: 0,
            skills: {
                logistics: 0,
                tacticalParity: 0,
                economicHeadstart: 0
            },
            unlockedColors: ['#0070f3'],
            selectedColor: '#0070f3',
            saves: [],
            activeGame: false
        };
    } else if (username) {
        state.db[playerId].username = username;
    }

    await saveState(state, playerId);

    return res.status(200).json(state.db[playerId]);
}
