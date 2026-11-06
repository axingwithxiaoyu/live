// 模板站歌曲接口：独立 key 前缀 demo-song/ + meta/demo-song/
function json(data, status){
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "content-type",
            "access-control-allow-methods": "GET, POST, OPTIONS"
        }
    });
}

let _storePromise = null;
function loadStore(){
    if(!_storePromise){
        _storePromise = import("@edgeone/pages-blob").then(m => {
            const gs = m.getStore || (m.default && m.default.getStore);
            return gs ? gs("media") : null;
        }).catch(() => { _storePromise = null; return null; });
    }
    return _storePromise;
}

async function metaGet(store, key){
    try{ const v = await store.get(key, { consistency: "strong" }); return v ? JSON.parse(v) : null; }
    catch(e){ return null; }
}

async function metaList(store){
    const out = [];
    try{
        const res = await store.list({ prefix: "meta/demo-song/", consistency: "strong" });
        for(const b of (res.blobs || [])){ const m = await metaGet(store, b.key); if(m) out.push(m); }
    }catch(e){}
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out;
}

export async function onRequest({ request }){
    if(request.method === "OPTIONS") return json({ ok: true });
    const store = await loadStore();
    if(!store) return json({ ok: false, error: "BLOB_NOT_READY" }, 500);

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if(request.method === "GET"){
        if(id){
            let type = "audio/mpeg";
            const meta = await metaGet(store, "meta/demo-song/" + id);
            if(meta && meta.type) type = meta.type;
            let data;
            try{ data = await store.get("demo-song/" + id, { type: "arrayBuffer", consistency: "strong" }); }
            catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": type, "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" }
            });
        }
        return json({ ok: true, songs: await metaList(store) });
    }

    if(request.method === "POST"){
        const mode = url.searchParams.get("mode");
        if(mode === "init"){
            let body = null; try{ body = await request.json(); }catch(e){}
            const size = Number(body && body.size) || 0;
            if(size <= 0) return json({ ok: false, error: "NO_FILES" }, 400);
            if(size > 30 * 1024 * 1024) return json({ ok: false, error: "FILE_TOO_LARGE" }, 400);
            let ctype = String((body && body.type) || "");
            if(ctype.indexOf("audio/") !== 0) ctype = "audio/mpeg";
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            try{
                const up = await store.createUploadUrl("demo-song/" + id, { contentType: ctype, expireSeconds: 3600 });
                return json({ ok: true, id: id, url: up.url });
            }catch(e){ return json({ ok: false, error: "UPLOAD_URL_FAIL" }, 500); }
        }
        if(mode === "finish"){
            let body = null; try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            try{ await store.getMetadata("demo-song/" + id, { consistency: "strong" }); }
            catch(e){ return json({ ok: false, error: "UPLOAD_NOT_FOUND" }, 400); }
            let ctype = String((body && body.type) || "");
            if(ctype.indexOf("audio/") !== 0) ctype = "audio/mpeg";
            const meta = {
                id, name: String((body && body.name) || "").slice(0, 50),
                type: ctype, ts: Date.now(),
                lrc: String((body && body.lrc) || "").slice(0, 5000)
            };
            try{ await store.set("meta/demo-song/" + id, JSON.stringify(meta)); }
            catch(e){ return json({ ok: false, error: "SAVE_FAIL" }, 500); }
            return json({ ok: true, saved: meta });
        }
        if(mode === "del"){
            let body = null; try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            try{ await store.delete("demo-song/" + id); }catch(e){}
            try{ await store.delete("meta/demo-song/" + id); }catch(e){}
            return json({ ok: true });
        }
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
