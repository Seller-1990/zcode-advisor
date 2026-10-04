#!/usr/bin/env python3
"""3 模型并发 OCR 评审 + 结果综合。

为什么需要：单个模型做评审会与作者共享盲区（用户 2026-10-04 提出）。改为一轮跑 3 个
不同厂商的模型，各自出意见，再合并——覆盖率高于任一单模型，且"多个模型都提到"的条目
可信度明显更高。

用法：
  python3 tools/multi-review.py <from> <to> [--out 合成结果.json] [--chain 第三槽位链文件]

槽位（固定）：
  1. nas-hy4/deepseek-v4.1-flash   —— 便宜快稳，主力
  2. nas-hy4/glm-5.3-flash         —— 便宜快，交叉审查
  3. 链文件第一条可用模型           —— 独立厂商视角
槽位 2 实测在大 diff 上会返回 status=partial（只覆盖部分分组）：**接受但如实标注**，
避免把"partial 的沉默"误读成"没问题"。

综合策略：并集去重 + 共性加权。
  - 三份意见按 (文件, 行号邻近, 内容相似) 归并
  - ≥2 个模型都提到 → high_confidence
  - 只 1 个模型提到 → single_source
"""
import argparse
import json
import os
import subprocess
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor

DEFAULT_CHAIN = os.path.expanduser('~/.dsh/templates/ocr-review/chain-public')

# 固定槽位 1/2（用户指定：便宜、快、成功率相对高，且互为交叉审查）
SLOT1 = ('nas-hy4', 'deepseek-v4.1-flash')
SLOT2 = ('nas-hy4', 'glm-5.3-flash')

SEV_ORDER = {'critical': 0, 'high': 1, 'major': 1, 'medium': 2, 'minor': 3, 'low': 3, 'info': 4}


def read_chain(path):
    """读链文件（scope|provider|model），返回 [(provider, model)]，跳过注释/空行。"""
    out = []
    with open(path, encoding='utf8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split('|')
            if len(parts) == 3 and all(parts):
                out.append((parts[1], parts[2]))
    return out


def pick_slot3(chain_path, taken):
    """第三槽位：链文件里第一个不与前两槽重复的模型。"""
    for prov, model in read_chain(chain_path):
        if (prov, model) not in taken:
            return prov, model
    return None


def run_one(slot_no, provider, model, frm, to, outfile):
    """跑一个槽位；完整输出与 returncode 都留着，供主流程判定。"""
    cmd = ['ocr', 'review', '--from', frm, '--to', to, '--format', 'json',
           '--output', outfile, '--provider', provider, '--model', model]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    data = None
    try:
        with open(outfile, encoding='utf8') as fh:
            data = json.load(fh)
    except Exception:
        data = None
    status = (data or {}).get('status') or 'no-output'
    comments = (data or {}).get('comments') or []
    return {
        'slot': slot_no,
        'provider': provider,
        'model': model,
        'exit': proc.returncode,
        'status': status,
        'comments': comments,
        # partial/failed 必须让下游看得见：它的"没意见"不等于"没问题"
        'coverage_ok': status == 'complete',
        'stderr_tail': (proc.stderr or '')[-400:],
    }


def norm(s):
    return ' '.join(str(s or '').split())


def text_key(s):
    """内容指纹：去掉标点与大小写差异，用于跨模型比对同一条意见。"""
    s = unicodedata.normalize('NFKC', norm(s)).lower()
    return ''.join(ch for ch in s if ch.isalnum())


def similar(a, b):
    """粗相似度：任一方为对方子串，或重合词占比高。够用且无需引依赖。"""
    ta, tb = text_key(a), text_key(b)
    if not ta or not tb:
        return False
    if ta in tb or tb in ta:
        return True
    sa, sb = set(a.lower().split()), set(b.lower().split())
    if not sa or not sb:
        return False
    return len(sa & sb) / min(len(sa), len(sb)) >= 0.6


def merge(results):
    """并集去重 + 共性加权。相同意见归并，记录哪些模型提到过。

    归并判据（务必别退回成 `near or similar`）：同一份 diff 里，**相邻行常常是不同问题**
    （密集改动区尤其如此）。早期实现用「行号邻近 OR 内容相似」，会把两条无关意见并成一条，
    直接损害"哪些问题被判为高置信"的结论——这比漏并更糟（漏并只是少一条，误并会让用户
    以为某个问题有两个模型背书）。
    现在的规则：
      - 行号邻近（±3）**且** 内容相似 → 同一条（同一处被两个模型以不同措辞描述）
      - 行号较远但内容高度相似 → 同一条（同一问题被定位到不同行）
      - 其余 → 各自独立
    """
    merged = []
    for r in results:
        for c in r['comments']:
            path = str(c.get('path') or '?')
            line = c.get('start_line')
            content = c.get('content') or ''
            hit = None
            for m in merged:
                if m['path'] != path:
                    continue
                # 无论行号远近，都**必须内容相似**才算同一条：
                # 同一份 diff 里相邻行常是不同问题（密集改动区尤其如此），
                # 只看行号会把无关意见并成一条 → 假的高置信，比漏并更糟。
                if similar(content, m['content']):
                    hit = m
                    break
            if hit is None:
                merged.append({
                    'path': path,
                    'start_line': line,
                    'severity': c.get('severity'),
                    'content': content,
                    'suggestion_code': c.get('suggestion_code'),
                    'category': c.get('category'),
                    'reported_by': [f"{r['provider']}/{r['model']}"],
                })
            else:
                tag = f"{r['provider']}/{r['model']}"
                if tag not in hit['reported_by']:
                    hit['reported_by'].append(tag)
                # 取更严重的那个等级
                if SEV_ORDER.get(str(c.get('severity')).lower(), 9) < \
                   SEV_ORDER.get(str(hit.get('severity')).lower(), 9):
                    hit['severity'] = c.get('severity')
    for m in merged:
        m['confidence'] = 'high' if len(m['reported_by']) >= 2 else 'single'
    merged.sort(key=lambda m: (SEV_ORDER.get(str(m.get('severity')).lower(), 9),
                               0 if m['confidence'] == 'high' else 1,
                               m['path'], m.get('start_line') or 0))
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frm')
    ap.add_argument('to')
    ap.add_argument('--out', default='/tmp/multi-review-result.json')
    ap.add_argument('--chain', default=DEFAULT_CHAIN)
    ap.add_argument('--workdir', default='/tmp')
    args = ap.parse_args()

    slots = [(1, *SLOT1)]
    if os.path.exists(args.chain):
        s3 = pick_slot3(args.chain, set(slots and [SLOT1, SLOT2]))
        if s3:
            slots.append((3, *s3))
    slots.append((2, *SLOT2))

    print(f'[multi-review] 范围 {args.frm}..{args.to}')
    for n, p, m in slots:
        print(f'  槽位{n}: {p}/{m}')
    print()

    # 临时文件名带 pid：固定名（mr-slot<N>.json）在并发跑两个评审时会互相覆盖，
    # 导致"结果 A 里混进结果 B"这种最难查的错误。/tmp 是共享目录，必须区分。
    tag = f'{os.getpid()}-{int(time.time())}'
    with ThreadPoolExecutor(max_workers=len(slots)) as ex:
        futs = [ex.submit(run_one, n, p, m, args.frm, args.to,
                          os.path.join(args.workdir, f'mr-slot{n}-{tag}.json'))
                for n, p, m in slots]
        results = [f.result() for f in futs]

    print('[multi-review] 各槽位结果：')
    for r in sorted(results, key=lambda x: x['slot']):
        flag = '✅' if r['coverage_ok'] else ('⚠️ ' if r['status'] == 'partial' else '❌')
        print(f"  {flag} 槽位{r['slot']} {r['provider']}/{r['model']}: "
              f"status={r['status']} exit={r['exit']} comments={len(r['comments'])}")
    print()

    merged = merge(results)
    hi = [m for m in merged if m['confidence'] == 'high']
    print(f'[multi-review] 合并后 {len(merged)} 条（其中 ≥2 模型共同提到 {len(hi)} 条）')
    for sev in ('critical', 'high', 'major'):
        for m in merged:
            if str(m.get('severity')).lower() == sev:
                mark = '★' if m['confidence'] == 'high' else ' '
                print(f"  {mark}[{m['severity']}] {m['path']}:{m['start_line']} ({len(m['reported_by'])} 模型)")

    payload = {
        'range': [args.frm, args.to],
        'slots': [{k: v for k, v in r.items() if k != 'comments'} for r in results],
        'merged': merged,
        'high_confidence': hi,
    }
    with open(args.out, 'w', encoding='utf8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f'\n[multi-review] 明细已写入 {args.out}')
    # 有槽位覆盖不全时以非零码提示（不阻断，便于脚本化发现）
    return 0 if all(r['coverage_ok'] for r in results) else 2


if __name__ == '__main__':
    sys.exit(main())
