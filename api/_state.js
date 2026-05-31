import fs from 'fs/promises';
import path from 'path';
import * as turf from '@turf/turf';

let inMemoryState = null;

function getCentroid(feature) {
    try {
        const centroid = turf.centroid(feature);
        return centroid.geometry.coordinates;
    } catch (e) {
        return [0, 0];
    }
}

export async function loadOriginalMap() {
    const geoPath = path.join(process.cwd(), 'map.geojson');
    const geoData = JSON.parse(await fs.readFile(geoPath, 'utf-8'));
    const originalFeatures = geoData.features.map(f => {
        const p = f.properties;
        const pop = p.POP_EST || 1000000;
        f.properties.owner = p.ADMIN;
        f.properties.gameStats = { pop: pop, mil: Math.floor(pop * 0.01) };
        return f;
    });

    originalFeatures.forEach(c1 => {
        c1.properties.neighbors = [];
        const cent1 = getCentroid(c1);
        originalFeatures.forEach(c2 => {
            if (c1 === c2) return;
            const cent2 = getCentroid(c2);
            const dist = Math.sqrt(Math.pow(cent1[0] - cent2[0], 2) + Math.pow(cent1[1] - cent2[1], 2));
            if (dist < 80) {
                c1.properties.neighbors.push(c2.properties.ADMIN);
            }
        });
    });

    return originalFeatures;
}

async function kvRequest(command, args = []) {
    const url = `${process.env.KV_REST_API_URL}/${command}/${args.join('/')}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
        cache: 'no-store'
    });
    return await res.json();
}

async function kvSet(key, value) {
    const url = `${process.env.KV_REST_API_URL}/set/${key}`;
    await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
        body: JSON.stringify(value),
        cache: 'no-store'
    });
}

function rowToProfile(row) {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        tokens: row.tokens || 0,
        skills: row.skills || { logistics: 0, tacticalParity: 0, economicHeadstart: 0 },
        stats: row.stats || { territoriesAnnexed: 0, peakMilitary: 0, wins: 0, survived: 0 },
        unlockedColors: row.unlocked_colors || ['#0070f3'],
        selectedColor: row.selected_color || '#0070f3',
        saves: row.saves || [],
        nukeUsed: !!row.nuke_used
    };
}

function profileToRow(profile) {
    if (!profile) return null;
    return {
        id: profile.id,
        username: profile.username,
        tokens: profile.tokens || 0,
        skills: profile.skills || { logistics: 0, tacticalParity: 0, economicHeadstart: 0 },
        stats: profile.stats || { territoriesAnnexed: 0, peakMilitary: 0, wins: 0, survived: 0 },
        unlocked_colors: profile.unlockedColors || ['#0070f3'],
        selected_color: profile.selectedColor || '#0070f3',
        saves: profile.saves || [],
        nuke_used: !!profile.nukeUsed,
        updated_at: new Date().toISOString()
    };
}

async function fetchProfile(playerId) {
    try {
        const res = await fetch(`https://epnjfsfveqbvoimpstbd.supabase.co/rest/v1/geopolitics_profiles?id=eq.${playerId}`, {
            headers: {
                'apikey': 'sb_publishable_12ymAaNfKTNDknIvcDVdEQ_l7P8jfdr',
                'Authorization': 'Bearer sb_publishable_12ymAaNfKTNDknIvcDVdEQ_l7P8jfdr'
            },
            cache: 'no-store'
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.length > 0) {
                return rowToProfile(data[0]);
            }
        }
    } catch (e) {
        console.error('Error fetching profile from Supabase', e);
    }
    return null;
}

async function upsertProfile(profile) {
    try {
        const row = profileToRow(profile);
        await fetch('https://epnjfsfveqbvoimpstbd.supabase.co/rest/v1/geopolitics_profiles', {
            method: 'POST',
            headers: {
                'apikey': 'sb_publishable_12ymAaNfKTNDknIvcDVdEQ_l7P8jfdr',
                'Authorization': 'Bearer sb_publishable_12ymAaNfKTNDknIvcDVdEQ_l7P8jfdr',
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify(row),
            cache: 'no-store'
        });
    } catch (e) {
        console.error('Error saving profile to Supabase', e);
    }
}

export async function getState(playerId) {
    const id = playerId || 'global';
    const useKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

    let state;
    if (useKV) {
        try {
            const stateRes = await kvRequest('get', [`geo:state:${id}`]);
            const dbRes = await kvRequest('get', ['geo:db']);

            let db = dbRes.result ? JSON.parse(dbRes.result) : {};
            let gameState = stateRes.result ? JSON.parse(stateRes.result) : null;

            if (!gameState) {
                const mapData = await loadOriginalMap();
                gameState = {
                    mapData,
                    lastTick: Date.now(),
                    activeEvents: [],
                    pendingActions: [],
                    isPaused: false,
                    difficulty: 'normal',
                    version: 1
                };
                await kvSet(`geo:state:${id}`, gameState);
                await kvSet('geo:db', db);
            }

            state = {
                mapData: gameState.mapData,
                lastTick: gameState.lastTick,
                activeEvents: gameState.activeEvents,
                pendingActions: gameState.pendingActions || [],
                isPaused: !!gameState.isPaused,
                difficulty: gameState.difficulty || 'normal',
                version: gameState.version || 1,
                db
            };
        } catch (e) {
            console.error('KV Read Error, falling back to memory', e);
        }
    }

    if (!state) {
        if (!inMemoryState) {
            inMemoryState = {
                states: {},
                db: {}
            };
        }
        if (!inMemoryState.states[id]) {
            const mapData = await loadOriginalMap();
            inMemoryState.states[id] = {
                mapData,
                lastTick: Date.now(),
                activeEvents: [],
                pendingActions: [],
                isPaused: false,
                version: 1
            };
        }
        state = {
            mapData: inMemoryState.states[id].mapData,
            lastTick: inMemoryState.states[id].lastTick,
            activeEvents: inMemoryState.states[id].activeEvents,
            pendingActions: inMemoryState.states[id].pendingActions,
            isPaused: inMemoryState.states[id].isPaused,
            difficulty: inMemoryState.states[id].difficulty,
            version: inMemoryState.states[id].version || 1,
            db: inMemoryState.db
        };
    }

    if (playerId) {
        const profile = await fetchProfile(playerId);
        if (profile) {
            if (!profile.skills || typeof profile.skills.invasion !== 'boolean') {
                profile.skills = {
                    invasion: true,
                    airstrike: false,
                    nuke: false,
                    propaganda: false,
                    intelHack: false,
                    logistics: false,
                    loadout: ['invasion']
                };
            }
            state.db[playerId] = profile;
        }
    }

    return state;
}

export async function saveState(state, playerId) {
    const id = playerId || 'global';
    state.version = (state.version || 0) + 1;

    if (playerId && state.db[playerId]) {
        await upsertProfile(state.db[playerId]);
    }

    const useKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

    if (useKV) {
        try {
            const gameState = {
                mapData: state.mapData,
                lastTick: state.lastTick,
                activeEvents: state.activeEvents,
                pendingActions: state.pendingActions || [],
                isPaused: !!state.isPaused,
                difficulty: state.difficulty || 'normal',
                version: state.version
            };
            await kvSet(`geo:state:${id}`, gameState);
            await kvSet('geo:db', state.db);
            return;
        } catch (e) {
            console.error('KV Save Error', e);
        }
    }

    if (inMemoryState) {
        inMemoryState.states[id] = {
            mapData: state.mapData,
            lastTick: state.lastTick,
            activeEvents: state.activeEvents,
            pendingActions: state.pendingActions,
            isPaused: state.isPaused,
            difficulty: state.difficulty,
            version: state.version
        };
        inMemoryState.db = state.db;
    }
}
