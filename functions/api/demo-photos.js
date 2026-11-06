// 模板站照片接口：独立 key 前缀 demo-photo/ + meta/demo-photo/
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
        const res = await store.list({ prefix: "meta/demo-photo/", consistency: "strong" });
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
            let type = "image/jpeg";
            const meta = await metaGet(store, "meta/demo-photo/" + id);
            if(meta && meta.type) type = meta.type;
            let data;
            try{ data = await store.get("demo-photo/" + id, { type: "arrayBuffer", consistency: "strong" }); }
            catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": type, "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" }
            });
        }
        return json({ ok: true, photos: await metaList(store) });
    }

    if(request.method === "POST"){
        const mode = url.searchParams.get("mode");
        if(mode === "init"){
            let body = null; try{ body = await request.json(); }catch(e){}
            const size = Number(body && body.size) || 0;
            if(size <= 0) return json({ ok: false, error: "NO_FILES" }, 400);
            if(size > 10 * 1024 * 1024) return json({ ok: false, error: "FILE_TOO_LARGE" }, 400);
            let ctype = String((body && body.type) || "");
            if(ctype.indexOf("image/") !== 0) ctype = "image/jpeg";
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            try{
                const up = await store.createUploadUrl("demo-photo/" + id, { contentType: ctype, expireSeconds: 3600 });
                return json({ ok: true, id: id, url: up.url });
            }catch(e){ return json({ ok: false, error: "UPLOAD_URL_FAIL" }, 500); }
        }
        if(mode === "finish"){
            let body = null; try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            try{ await store.getMetadata("demo-photo/" + id, { consistency: "strong" }); }
            catch(e){ return json({ ok: false, error: "UPLOAD_NOT_FOUND" }, 400); }
            let ctype = String((body && body.type) || "");
            if(ctype.indexOf("image/") !== 0) ctype = "image/jpeg";
            const rawAlbum = String((body && body.album) || "");
            const meta = {
                id: id,
                name: String((body && body.name) || "").slice(0, 50),
                type: ctype,
                ts: Date.now(),
                album: (rawAlbum === "我的世界" || rawAlbum === "第五人格") ? rawAlbum : "其他"
            };
            try{ await store.set("meta/demo-photo/" + id, JSON.stringify(meta)); }
            catch(e){ return json({ ok: false, error: "SAVE_FAIL" }, 500); }
            return json({ ok: true, saved: meta });
        }
        if(mode === "del"){
            let body = null; try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            try{ await store.delete("demo-photo/" + id); }catch(e){}
            try{ await store.delete("meta/demo-photo/" + id); }catch(e){}
            return json({ ok: true });
        }
        // 兼容 multipart
        let form; try{ form = await request.formData(); }catch(e){ return json({ ok: false, error: "BAD_FORM" }, 400); }
        const files = form.getAll("files").filter(f => f && typeof f === "object" && f.size > 0);
        if(files.length === 0) return json({ ok: false, error: "NO_FILES" }, 400);
        const saved = [];
        for(const f of files){
            if(f.size > 10 * 1024 * 1024) continue;
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            try{
                const buf = await f.arrayBuffer();
                await store.set("demo-photo/" + id, buf);
            }catch(e){ continue; }
            const meta = { id, name: String(f.name || "").slice(0, 50), type: f.type || "image/jpeg", ts: Date.now(), album: "其他" };
            try{ await store.set("meta/demo-photo/" + id, JSON.stringify(meta)); }catch(e){}
            saved.push(meta);
        }
        if(saved.length === 0) return json({ ok: false, error: "SAVE_FAIL" }, 500);
        return json({ ok: true, saved });
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
