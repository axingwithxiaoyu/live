// 照片接口：GET 列表 / GET ?id=xx 取图 / POST 上传(multipart, 字段名 files)
// 全部走新版 Blob SDK（@edgeone/pages-blob，media 库，自动创建无需绑定）
// 二进制键 photo/<id>，元数据键 meta/photo/<id>

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
    try{
        const v = await store.get(key, { consistency: "strong" });
        return v ? JSON.parse(v) : null;
    }catch(e){ return null; }
}

async function metaList(store, prefix){
    const out = [];
    try{
        const res = await store.list({ prefix: prefix, consistency: "strong" });
        for(const b of (res.blobs || [])){
            const m = await metaGet(store, b.key);
            if(m) out.push(m);
        }
    }catch(e){}
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
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
            const meta = await metaGet(store, "meta/photo/" + id);
            if(meta && meta.type) type = meta.type;
            let data;
            try{
                data = await store.get("photo/" + id, { type: "arrayBuffer", consistency: "strong" });
            }catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": type, "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" }
            });
        }
        return json({ ok: true, photos: await metaList(store, "meta/photo/") });
    }

    if(request.method === "POST"){
        let form;
        try{ form = await request.formData(); }catch(e){ return json({ ok: false, error: "BAD_FORM" }, 400); }
        const files = form.getAll("files").filter(f => f && typeof f === "object" && f.size > 0);
        if(files.length === 0) return json({ ok: false, error: "NO_FILES" }, 400);
        const saved = [];
        for(const f of files){
            if(f.size > 10 * 1024 * 1024) continue;
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            try{
                const buf = await f.arrayBuffer();
                await store.set("photo/" + id, buf);
            }catch(e){ continue; }
            const meta = { id: id, name: String(f.name || "").slice(0, 50), type: f.type || "image/jpeg", ts: Date.now() };
            try{ await store.set("meta/photo/" + id, JSON.stringify(meta)); }catch(e){}
            saved.push(meta);
        }
        if(saved.length === 0) return json({ ok: false, error: "SAVE_FAIL" }, 500);
        return json({ ok: true, saved: saved });
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
