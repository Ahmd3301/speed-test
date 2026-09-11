#!/usr/bin/env python3
"""
dl_progress.py — شريط تقدم حقيقي أثناء تنزيل N_m3u8DL-RE.

يقيس البايتات المستلمة فعلاً على واجهة الشبكة (/proc/net/dev) مقابل حجم
متوقع (يُمرَّر من الـ workflow بتقدير HEAD لعينة مقاطع × عددها)، ويطبع:
Downloading...
[■■■■■■■□□□] 75%
ETA: 00:00:00
Speed: 00 MB/s
Average CPU Usage:
Average RAM Usage:

■ = 10% منجزة، □ = 10% متبقية. عند الإنهاء (SIGTERM) يطبع عينة أخيرة.
ملاحظة صدق: العداد شبكي (يشمل كل حركة الـ Runner) والتوقع تقديري،
لذا قد يلامس 100% قبل الدمج النهائي — الدمج المحلي لا يستهلك شبكة.
"""
import argparse
import signal
import sys
import time

sys.path.insert(0, __import__('os').path.join(
    __import__('os').path.dirname(__import__('os').path.abspath(__file__))))
from tg_upload import bar, fmt_eta, read_cpu, cpu_pct_since, mem_used_mb  # noqa


def pick_iface():
    best, best_rx = 'eth0', -1
    try:
        with open('/proc/net/dev') as f:
            for line in f:
                if ':' not in line:
                    continue
                name, rest = line.split(':', 1)
                name = name.strip()
                if name == 'lo':
                    continue
                rx = int(rest.split()[0])
                if rx > best_rx:
                    best, best_rx = name, rx
    except FileNotFoundError:
        pass
    return best


def read_rx(iface):
    try:
        with open('/proc/net/dev') as f:
            for line in f:
                if ':' not in line:
                    continue
                name, rest = line.split(':', 1)
                if name.strip() == iface:
                    return int(rest.split()[0])
    except FileNotFoundError:
        pass
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--expected-bytes', type=float, required=True)
    ap.add_argument('--title', default='Downloading...')
    ap.add_argument('--interval', type=float, default=3.0)
    a = ap.parse_args()

    iface = pick_iface()
    rx0 = read_rx(iface)
    cpu_prev = read_cpu()
    cpu_sum = cpu_n = 0
    mem_sum = mem_n = 0
    last_rx, last_t = rx0, time.time()
    stop = {'flag': False}

    def on_term(signum, frame):
        stop['flag'] = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)

    def show(final=False):
        nonlocal cpu_prev, cpu_sum, cpu_n, mem_sum, mem_n, last_rx, last_t
        now = time.time()
        rx = read_rx(iface)
        got = rx - rx0
        pct = min(100.0, got / a.expected_bytes * 100) if a.expected_bytes > 0 else 0
        dt = now - last_t or 1e-6
        speed = (rx - last_rx) / dt / 1024 / 1024
        last_rx, last_t = rx, now
        p, cpu_prev = cpu_pct_since(cpu_prev)
        cpu_sum += p
        cpu_n += 1
        mem_sum += mem_used_mb()
        mem_n += 1
        rem = max(0.0, a.expected_bytes - got)
        eta = rem / (speed * 1024 * 1024) if speed > 0.01 else None
        tag = ' (final)' if final else ''
        print(f'{a.title}{tag}\n[{bar(pct)}] {pct:.0f}%\n'
              f'ETA: {fmt_eta(eta)}\nSpeed: {speed:.0f} MB/s\n'
              f'Average CPU Usage: {cpu_sum / cpu_n:.1f}%\n'
              f'Average RAM Usage: {mem_sum / mem_n:.0f} MB', flush=True)

    while not stop['flag']:
        time.sleep(a.interval)
        if not stop['flag']:
            show()
    show(final=True)


if __name__ == '__main__':
    main()
