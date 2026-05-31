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

async function loadOriginalMap() {
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
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    return await res.json();
}

async function kvSet(key, value) {
    const url = `${process.env.KV_REST_API_URL}/set/${key}`;
    await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
        body: JSON.stringify(value)
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
        saves: row.saves || []
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
        updated_at: new Date().toISOString()
    };
}

async function fetchProfile(playerId) {
    try {
        const res = await fetch(`https://epnjfsfveqbvoimpstbd.supabase.co/rest/v1/geopolitics_profiles?id=eq.${playerId}`, {
            headers: {
                'apikey': 'sb_publishable_12ymAaNfKTNDknIvcDVdEQ_l7P8jfdr',
                'Authorization': 'Bearer sb_publishable_12ymAaNfKTNDknIvcDVdEQ_l7P8jfdr'
            }
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
            body: JSON.stringify(row)
        });
    } catch (e) {
        console.error('Error saving profile to Supabase', e);
    }
}

export async function getState(playerId) {
    const useKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

    let state;
    if (useKV) {
        try {
            const mapRes = await kvRequest('get', ['geo:map_data']);
            const tickRes = await kvRequest('get', ['geo:last_tick']);
            const eventsRes = await kvRequest('get', ['geo:active_events']);
            const dbRes = await kvRequest('get', ['geo:db']);

            let mapData = mapRes.result ? JSON.parse(mapRes.result) : null;
            let lastTick = tickRes.result ? parseInt(tickRes.result) : null;
            let activeEvents = eventsRes.result ? JSON.parse(eventsRes.result) : [];
            let db = dbRes.result ? JSON.parse(dbRes.result) : {};

            if (!mapData) {
                mapData = await loadOriginalMap();
                lastTick = Date.now();
                await kvSet('geo:map_data', JSON.stringify(mapData));
                await kvSet('geo:last_tick', lastTick.toString());
                await kvSet('geo:active_events', JSON.stringify(activeEvents));
                await kvSet('geo:db', JSON.stringify(db));
            }

            state = { mapData, lastTick, activeEvents, db };
        } catch (e) {
            console.error('KV Read Error, falling back to memory', e);
        }
    }

    if (!state) {
        if (!inMemoryState) {
            const mapData = await loadOriginalMap();
            inMemoryState = {
                mapData,
                lastTick: Date.now(),
                activeEvents: [],
                db: {}
            };
        }
        state = inMemoryState;
    }

    if (playerId) {
        const profile = await fetchProfile(playerId);
        if (profile) {
            state.db[playerId] = profile;
        }
    }

    return state;
}

export async function saveState(state, playerId) {
    if (playerId && state.db[playerId]) {
        await upsertProfile(state.db[playerId]);
    }

    const useKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

    if (useKV) {
        try {
            await kvSet('geo:map_data', JSON.stringify(state.mapData));
            await kvSet('geo:last_tick', state.lastTick.toString());
            await kvSet('geo:active_events', JSON.stringify(state.activeEvents));
            await kvSet('geo:db', JSON.stringify(state.db));
            return;
        } catch (e) {
            console.error('KV Save Error', e);
        }
    }

    inMemoryState = state;
}
