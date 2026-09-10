#!/usr/bin/env python3
"""
tg_upload.py — رفع ملف MP4 إلى تليجرام عبر Local Bot API Server بأقصى سرعة.

- يقرأ الملف من القرص مباشرة (streaming multipart) دون تحميله في الذاكرة.
- إن تجاوز الحجم PART_MAX (1.9GB) يقسّمه بايت-wise إلى PART 1..N ويعيد تجميعها بـ cat.
- يحترم Rate Limit: عند 429 ينام retry_after ثم يعيد (حتى 5 محاولات)، وبين الأجزاء نوم قصير.
- يطبع سطور RESULT_ وملخص JSON (بدون أي أسرار).

الاستخدام:
  python3 scripts/tg_upload.py --file movie.mp4 --api-base http://127.0.0.1:8081 \
      --token "$BOT_TOKEN" --chat-id "$CHAT_ID" --caption "Oppenheimer 1080p" --out ./tg-results
ملاحظة: مرّر التوكن عبر متغير بيئة TG_TOKEN بدلاً من سطر الأوامر إن أمكن.
"""
import argparse
import hashlib
import http.client
import json
import os
import subprocess
import sys
import time
import urllib.parse

PART_MAX = 1900 * 1024 * 1024  # 1.9 GiB — بهامش أمان تحت سقف 2000MB للسيرفر المحلي
CHUNK = 1024 * 1024            # 1 MiB لكل قراءة أثناء الرفع
RETRY_429_MAX = 5
GAP_BETWEEN_PARTS = 5          # ثوانٍ بين الأجزاء (أمان من Flood)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(8 * 1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def split_file(path, out_dir, part_max=PART_MAX):
    size = os.path.getsize(path)
    if size <= part_max:
        return [(path, size, 1, 1)]
    base = os.path.join(out_dir, os.path.basename(path) + '.part')
    r = subprocess.run(['split', '-b', str(part_max), '-d',
                        '--suffix-length=2', path, base],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('split failed: ' + r.stderr[:500])
    parts = sorted(f for f in os.listdir(out_dir)
                   if f.startswith(os.path.basename(path) + '.part'))
    out = []
    for i, name in enumerate(parts, 1):
        p = os.path.join(out_dir, name)
        out.append((p, os.path.getsize(p), i, len(parts)))
    return out


class StreamingMultipart:
    """multipart/form-data يُبثّ من القرص دون تحميل الملف في الذاكرة."""
    def __init__(self, fields, file_field, file_path, file_name):
        self.boundary = '----tgup' + hashlib.md5(
            os.urandom(16)).hexdigest()
        self.fields = fields
        self.file_field = file_field
        self.file_path = file_path
        self.file_name = file_name
        self.file_size = os.path.getsize(file_path)
        pre = b''
        for k, v in fields.items():
            pre += ('--' + self.boundary + '\r\n').encode()
            pre += (f'Content-Disposition: form-data; name="{k}"\r\n\r\n').encode()
            pre += str(v).encode() + b'\r\n'
        pre += ('--' + self.boundary + '\r\n').encode()
        pre += (f'Content-Disposition: form-data; name="{file_field}"; '
                f'filename="{file_name}"\r\n'
                f'Content-Type: video/mp4\r\n\r\n').encode()
        self.pre = pre
        self.post = ('\r\n--' + self.boundary + '--\r\n').encode()
        self.total = len(pre) + self.file_size + len(post)

    def body_iter(self):
        yield self.pre
        with open(self.file_path, 'rb') as f:
            while True:
                b = f.read(CHUNK)
                if not b:
                    break
                yield b
        yield self.post


def post_multipart(api_base, token, method, fields, file_path, timeout=3600):
    u = urllib.parse.urlparse(api_base)
    host, port = u.hostname, u.port or 80
    mp = StreamingMultipart(fields, 'document', file_path,
                            os.path.basename(file_path))
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    conn.putrequest('POST', f'/bot{token}/{method}')
    conn.putheader('Content-Type',
                   f'multipart/form-data; boundary={mp.boundary}')
    conn.putheader('Content-Length', str(mp.total))
    conn.endheaders()
    sent = 0
    t0 = time.time()
    for piece in mp.body_iter():
        conn.send(piece)
        sent += len(piece)
    resp = conn.getresponse()
    data = resp.read()
    dt = time.time() - t0
    try:
        return json.loads(data.decode('utf8', 'replace')), dt, mp.total
    except Exception:
        return {'ok': False, 'error_code': resp.status,
                'description': data[:300].decode('utf8', 'replace')}, dt, mp.total


def send_part(api_base, token, chat_id, file_path, caption):
    fields = {'chat_id': chat_id, 'caption': caption[:1024]}
    for attempt in range(1, RETRY_429_MAX + 1):
        res, dt, sent_bytes = post_multipart(api_base, token,
                                             'sendDocument', fields,
                                             file_path)
        if res.get('ok'):
            doc = res['result'].get('document', {})
            return {'ok': True,
                    'message_id': res['result'].get('message_id'),
                    'file_id': doc.get('file_id'),
                    'file_size': doc.get('file_size'),
                    'seconds': round(dt, 1),
                    'mbps': round(sent_bytes * 8 / dt / 1e6, 1)
                    if dt > 0 else 0}
        desc = str(res.get('description', ''))
        if res.get('error_code') == 429 or 'retry' in desc.lower():
            wait = 30
            try:
                wait = int(res.get('parameters', {}).get('retry_after', 30))
            except Exception:
                pass
            print(f'  429 flood control, sleeping {wait}s '
                  f'(attempt {attempt})', flush=True)
            time.sleep(wait + 2)
            continue
        return {'ok': False, 'error': desc[:300], 'seconds': round(dt, 1)}
    return {'ok': False, 'error': 'retries exhausted on 429'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True)
    ap.add_argument('--api-base', default='http://127.0.0.1:8081')
    ap.add_argument('--token', default=os.environ.get('TG_TOKEN', ''))
    ap.add_argument('--chat-id', required=True)
    ap.add_argument('--caption', default='')
    ap.add_argument('--out', default='./tg-results')
    ap.add_argument('--part-max', type=int, default=PART_MAX)
    a = ap.parse_args()
    if not a.token:
        print('FATAL: missing bot token (use --token or TG_TOKEN)', flush=True)
        return 1
    os.makedirs(a.out, exist_ok=True)
    total_size = os.path.getsize(a.file)
    print(f'SOURCE size={total_size} bytes '
          f'({total_size/1024/1024:.1f} MB) sha={sha256_file(a.file)[:16]}…',
          flush=True)
    parts = split_file(a.file, a.out, a.part_max)
    print(f'PARTS count={len(parts)} (limit {a.part_max} bytes each)', flush=True)
    results, t_all0 = [], time.time()
    for path, size, idx, total in parts:
        cap = (f'{a.caption}\nPART {idx}/{total} '
               f'({size/1024/1024:.0f} MB) — rejoin: cat *.part* > movie.mp4'
               if total > 1 else a.caption)
        print(f'UPLOAD part {idx}/{total}: {os.path.basename(path)} '
              f'{size/1024/1024:.1f} MB …', flush=True)
        r = send_part(a.api_base, a.token, a.chat_id, path, cap)
        r.update({'part': idx, 'of': total, 'bytes': size,
                  'name': os.path.basename(path)})
        results.append(r)
        if r['ok']:
            print(f"  RESULT_PART_{idx}=OK message_id={r['message_id']} "
                  f"in {r['seconds']}s = {r['mbps']} Mbps", flush=True)
        else:
            print(f"  RESULT_PART_{idx}=FAIL {r.get('error')}", flush=True)
            break
        if idx < total:
            time.sleep(GAP_BETWEEN_PARTS)
    wall = time.time() - t_all0
    ok_all = all(r['ok'] for r in results) and len(results) == len(parts)
    summary = {'file': os.path.basename(a.file),
               'total_bytes': total_size,
               'parts': results, 'all_ok': ok_all,
               'wall_seconds': round(wall, 1),
               'wall_minutes': round(wall / 60, 2)}
    with open(os.path.join(a.out, 'upload-report.json'), 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"RESULT_UPLOAD_ALL={'OK' if ok_all else 'FAIL'} "
          f"parts={len(results)}/{len(parts)} in {wall/60:.2f} min", flush=True)
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
