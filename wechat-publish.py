#!/usr/bin/env python3
"""
通跃检测 — 技术指南 → 微信公众号 转换工具
用法: python3 wechat-publish.py <guide-xxx.html>
输出: guide-xxx-wechat.html (浏览器打开后全选复制粘贴到公众号编辑器)
"""

import sys, re, os

WECHAT_CSS = """
body { margin:0; padding:0; background:#fff; font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif; color:#333; font-size:15px; line-height:1.8; }
.header { background:linear-gradient(135deg,#1b3a6b,#2563a8); color:#fff; text-align:center; padding:30px 20px; }
.header h1 { font-size:20px; font-weight:700; margin:0 0 8px; line-height:1.4; }
.header p { font-size:14px; opacity:0.8; margin:0; }
.intro { background:#f4f7fc; border-radius:8px; padding:16px 20px; margin:16px; }
.intro h2 { font-size:17px; color:#1b3a6b; margin:0 0 8px; }
.intro p { font-size:14px; color:#555; margin:0; line-height:1.8; }
.sec { margin:0 12px 14px; border:1px solid #e8eef8; border-radius:8px; overflow:hidden; }
.sec-title { background:#f8faff; padding:12px 16px; font-size:16px; font-weight:700; color:#1b3a6b; border-left:4px solid #1b3a6b; }
.sec-body { padding:14px 16px; font-size:14px; color:#444; line-height:1.9; }
.sec-body ul, .sec-body ol { padding-left:1.2em; margin:6px 0; }
.sec-body li { margin-bottom:4px; }
.sec-body strong { color:#1b3a6b; }
.sec-body .note { background:#fff8e1; border-left:3px solid #f0c040; padding:10px 14px; margin:10px 0; font-size:13px; color:#6b5a00; border-radius:0 6px 6px 0; }
.sec-body .danger { background:#fff0f0; border-left:3px solid #e04040; padding:10px 14px; margin:10px 0; font-size:13px; color:#8b0000; border-radius:0 6px 6px 0; }
.sec-body table { width:100%; border-collapse:collapse; font-size:13px; margin:10px 0; }
.sec-body th { background:#f0f5ff; padding:8px; border:1px solid #dde4ef; text-align:left; }
.sec-body td { padding:8px; border:1px solid #e8eef8; }
.footer { background:#1b3a6b; color:#fff; text-align:center; padding:24px 16px; margin-top:20px; }
.footer .name { font-size:15px; font-weight:600; margin:0 0 6px; }
.footer .info { font-size:12px; opacity:0.7; margin:0; }
.copyright { text-align:center; padding:16px; color:#999; font-size:12px; }
.img-placeholder { text-align:center; padding:20px; background:#f8f8f8; border:1px dashed #ddd; border-radius:8px; color:#999; font-size:13px; margin:10px 0; }
"""


def clean_html(html):
    """Clean HTML for WeChat compatibility"""
    html = re.sub(r'\s*data-i18n="[^"]*"', '', html)
    html = re.sub(r'\s*data-i18n-alt="[^"]*"', '', html)
    html = re.sub(r'\s*loading="lazy"', '', html)
    html = re.sub(r'\s*onclick="[^"]*"', '', html)
    html = re.sub(r'<img[^>]*>', '<div class="img-placeholder">📷 [请手动上传图片]</div>', html)
    html = re.sub(r'<br\s*/?>', '', html)
    return html.strip()


def extract_content(html_path):
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Title
    title = re.search(r'<title>(.*?) — ', content)
    title = title.group(1) if title else ''

    # Hero
    hero_h1 = re.search(r'data-i18n="hero-h1">(.*?)<', content)
    hero_p = re.search(r'data-i18n="hero-p">(.*?)<', content)
    hero_title = hero_h1.group(1) if hero_h1 else title
    hero_subtitle = hero_p.group(1) if hero_p else ''

    # Intro
    intro_title = re.search(r'data-i18n="intro-title">(.*?)<', content)
    intro_text = re.search(r'data-i18n="intro-text">(.*?)<', content)

    # Extract all sections - find each accordion block
    sections = []
    # Find all accordion divs
    blocks = re.finditer(
        r'<div class="accordion[^"]*">\s*'
        r'<button[^>]*>\s*'
        r'<span[^>]*>(.*?)</span>.*?'
        r'</button>\s*'
        r'<div class="accordion-body">(.*?)</div>\s*</div>',
        content, re.DOTALL
    )
    for m in blocks:
        sec_title = m.group(1).strip()
        sec_body = clean_html(m.group(2))
        sections.append({'title': sec_title, 'body': sec_body})

    contact = {
        'name': '通跃检测',
        'info': 'Mindy：mindy.liu@nbth-ha.com  |  陆先生：yueping@nbty-ha.com'
    }

    return {
        'title': hero_title,
        'subtitle': hero_subtitle,
        'intro_title': intro_title.group(1) if intro_title else '概述',
        'intro_text': intro_text.group(1) if intro_text else '',
        'sections': sections,
        'contact': contact
    }


def generate_wechat_html(data):
    t = data['title']
    st = data['subtitle']
    it = data['intro_title']
    ib = data['intro_text']
    contact = data['contact']

    html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{t}</title>
<style>{WECHAT_CSS}</style>
</head>
<body>

<div class="header">
  <h1>{t}</h1>
  <p>{st}</p>
</div>

<div class="intro">
  <h2>{it}</h2>
  <p>{ib}</p>
</div>
'''

    for sec in data['sections']:
        html += f'''
<div class="sec">
  <div class="sec-title">{sec['title']}</div>
  <div class="sec-body">{sec['body']}</div>
</div>
'''

    html += f'''
<div class="footer">
  <p class="name">{contact['name']}</p>
  <p class="info">{contact['info']}</p>
</div>

<div class="copyright">
  宁波市通跃检测技术有限公司<br>Ningbo Tongyue Testing Technology Co., Ltd.
</div>

</body>
</html>'''

    return html


def main():
    if len(sys.argv) < 2:
        print("用法: python3 wechat-publish.py <guide-xxx.html>")
        print("示例: python3 wechat-publish.py guide-un38.3.html")
        sys.exit(1)

    source = sys.argv[1]
    if not os.path.exists(source):
        source = os.path.join('/Users/happy/tongyue', source)
        if not os.path.exists(source):
            print(f"文件不存在: {sys.argv[1]}")
            sys.exit(1)

    print(f"📖 读取: {source}")
    data = extract_content(source)
    wechat_html = generate_wechat_html(data)

    out_name = os.path.splitext(os.path.basename(source))[0] + '-wechat.html'
    out_path = os.path.join('/Users/happy/tongyue', out_name)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(wechat_html)

    print(f"✅ 已生成: {out_path}")
    print(f"📋 标题: {data['title']}")
    print(f"📝 章节数: {len(data['sections'])}")
    print(f"\n使用方法:")
    print(f"  1. 浏览器打开 {out_path}")
    print(f"  2. Ctrl+A 全选 → Ctrl+C 复制")
    print(f"  3. 粘贴到微信公众号编辑器")
    print(f"  4. 手动上传图片替换占位符")


if __name__ == '__main__':
    main()