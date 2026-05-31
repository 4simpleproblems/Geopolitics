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

export async function getState() {
    const useKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

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

            return { mapData, lastTick, activeEvents, db };
        } catch (e) {
            console.error('KV Read Error, falling back to memory', e);
        }
    }

    if (!inMemoryState) {
        const mapData = await loadOriginalMap();
        inMemoryState = {
            mapData,
            lastTick: Date.now(),
            activeEvents: [],
            db: {}
        };
    }

    return inMemoryState;
}

export async function saveState(state) {
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
