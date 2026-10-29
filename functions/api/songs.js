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
            const total = data.byteLength;
            const baseHeaders = {
                "content-type": "audio/mpeg",
                "accept-ranges": "bytes",
                "cache-control": "public, max-age=86400",
                "access-control-allow-origin": "*"
            };
            // 边缘函数响应体同样受限（约1MB）：支持 Range 分段返回，每段最大 900KB，浏览器播放器会自动续段
            const range = request.headers.get("range");
            const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
            if(m){
                let start = m[1] ? parseInt(m[1], 10) : 0;
                let end = m[2] ? parseInt(m[2], 10) : total - 1;
                if(!(start >= 0) || start >= total){
                    return new Response(null, { status: 416, headers: { "content-range": "bytes */" + total } });
                }
                if(!(end >= start) || end >= total) end = total - 1;
                const MAXCHUNK = 900 * 1024;
                if(end - start + 1 > MAXCHUNK) end = start + MAXCHUNK - 1;
                return new Response(data.slice(start, end + 1), {
                    status: 206,
                    headers: Object.assign({}, baseHeaders, {
                        "content-range": "bytes " + start + "-" + end + "/" + total
                    })
                });
            }
            return new Response(data, { headers: baseHeaders });
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
        const mode = url.searchParams.get("mode");
        // mode=init：生成浏览器直传地址（EdgeOne 函数请求体上限 1MB，大文件必须绕开函数）
        if(mode === "init"){
            let body = null;
            try{ body = await request.json(); }catch(e){}
            const size = Number(body && body.size) || 0;
            if(size <= 0) return json({ ok: false, error: "NO_MP3" }, 400);
            if(size > 50 * 1024 * 1024) return json({ ok: false, error: "MP3_TOO_LARGE" }, 400);
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            try{
                const up = await store.createUploadUrl("song/" + id + ".mp3", { contentType: "audio/mpeg", expireSeconds: 3600 });
                return json({ ok: true, id: id, url: up.url });
            }catch(e){ return json({ ok: false, error: "UPLOAD_URL_FAIL" }, 500); }
        }
        // mode=finish：直传完成后校验并登记元数据（lrc 文本随 JSON 带上）
        if(mode === "finish"){
            let body = null;
            try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            try{
                const md = await store.getMetadata("song/" + id + ".mp3", { consistency: "strong" });
                if(!md) return json({ ok: false, error: "UPLOAD_NOT_FOUND" }, 400);
            }catch(e){ return json({ ok: false, error: "UPLOAD_NOT_FOUND" }, 400); }
            let hasLrc = false;
            const lrcText = String((body && body.lrc) || "");
            if(lrcText && lrcText.length < 200 * 1024){
                try{ await store.set("song/" + id + ".lrc", lrcText); hasLrc = true; }catch(e){}
            }
            const rawName = String((body && body.name) || "未命名").replace(/\.mp3$/i, "");
            const meta = { id: id, name: rawName.slice(0, 50), hasLrc: hasLrc, ts: Date.now() };
            try{ await store.set("meta/song/" + id, JSON.stringify(meta)); }catch(e){ return json({ ok: false, error: "SAVE_FAIL" }, 500); }
            return json({ ok: true, song: meta });
        }
        // mode=del：删除歌曲（音频 + 歌词 + 元数据）
        if(mode === "del"){
            let body = null;
            try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            try{ await store.delete("song/" + id + ".mp3"); }catch(e){}
            try{ await store.delete("song/" + id + ".lrc"); }catch(e){}
            try{ await store.delete("meta/song/" + id); }catch(e){}
            return json({ ok: true });
        }
        // 兼容：≤1MB 小文件的旧直传（multipart）
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
