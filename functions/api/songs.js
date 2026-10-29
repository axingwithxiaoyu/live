// 歌曲接口：GET 列表 / GET ?file=id 取音频 / GET ?lrc=id 取歌词 / POST 上传(mp3必选 + 可选lrc)
// 全部走新版 Blob SDK（@edgeone/pages-blob，media 库，自动创建无需绑定）
// 音频键 song/<id>.mp3，歌词键 song/<id>.lrc，元数据键 meta/song/<id>

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

async function metaList(store, prefix){
    const out = [];
    try{
        const res = await store.list({ prefix: prefix, consistency: "strong" });
        for(const b of (res.blobs || [])){
            try{
                const v = await store.get(b.key, { consistency: "strong" });
                if(v) out.push(JSON.parse(v));
            }catch(e){}
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
    const fileId = url.searchParams.get("file");
    const lrcId = url.searchParams.get("lrc");

    if(request.method === "GET"){
        if(fileId){
            let data;
            try{
                data = await store.get("song/" + fileId + ".mp3", { type: "arrayBuffer", consistency: "strong" });
            }catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" }
            });
        }
        if(lrcId){
            let data;
            try{
                data = await store.get("song/" + lrcId + ".lrc", { consistency: "strong" });
            }catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" }
            });
        }
        return json({ ok: true, songs: await metaList(store, "meta/song/") });
    }

    if(request.method === "POST"){
        let form;
        try{ form = await request.formData(); }catch(e){ return json({ ok: false, error: "BAD_FORM" }, 400); }
        const mp3 = form.get("mp3");
        if(!mp3 || typeof mp3 === "string" || mp3.size === 0) return json({ ok: false, error: "NO_MP3" }, 400);
        if(mp3.size > 30 * 1024 * 1024) return json({ ok: false, error: "MP3_TOO_LARGE" }, 400);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        try{
            const buf = await mp3.arrayBuffer();
            await store.set("song/" + id + ".mp3", buf);
        }catch(e){ return json({ ok: false, error: "BLOB_PUT_FAIL" }, 500); }
        let hasLrc = false;
        const lrc = form.get("lrc");
        if(lrc && typeof lrc !== "string" && lrc.size > 0 && lrc.size < 200 * 1024){
            try{
                const text = await lrc.text();
                await store.set("song/" + id + ".lrc", text);
                hasLrc = true;
            }catch(e){}
        }
        const rawName = String(mp3.name || "未命名").replace(/\.mp3$/i, "");
        const meta = { id: id, name: rawName.slice(0, 50), hasLrc: hasLrc, ts: Date.now() };
        try{ await store.set("meta/song/" + id, JSON.stringify(meta)); }catch(e){}
        return json({ ok: true, song: meta });
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
