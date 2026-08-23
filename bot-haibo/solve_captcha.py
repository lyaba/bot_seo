#!/usr/bin/env python3
"""
Yandex Captcha Solver via CapMonster Cloud (free) or Local Server.
Supports:
  - Cloud API: https://api.capmonster.cloud (free, no key needed for basic)
  - Local server: CapMonster desktop app or Docker container

Usage:
  python solve_captcha.py                          # interactive mode
  python solve_captcha.py --url <yandex_captcha_url>  # solve specific captcha page
  python solve_captcha.py --proxy host:port:user:pass  # with proxy for solving

Config: config/captcha.json (optional)
"""

import json
import os
import sys
import time
import requests
from pathlib import Path
from urllib.parse import urlparse, urljoin, quote

# ─── Config ──────────────────────────────────────────────
DEFAULT_WEBSITE_KEY = "0x4AAAAAAA1Y6Rq8M2BnJfIe"

DEFAULT_CONFIG = {
    "mode": "cloud",  # "cloud" or "local"
    "cloud": {
        "api_url": "https://api.capmonster.cloud",
        "api_key": "",  # leave empty for free tier (limited)
        "timeout": 120,
        "poll_interval": 3,
    },
    "local": {
        "server_url": "http://localhost:3000",
        "api_key": "",
        "timeout": 120,
        "poll_interval": 3,
    },
    "solving": {
        "proxy_for_solving": None,  # host:port:user:pass
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "task_create_retries": 3,
    },
}

CONFIG_PATH = Path(__file__).parent / "config" / "captcha.json"


def load_config():
    """Load config from file or use defaults."""
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r") as f:
            user_cfg = json.load(f)
        # Merge with defaults
        cfg = DEFAULT_CONFIG.copy()
        for key in user_cfg:
            if isinstance(user_cfg[key], dict) and key in cfg and isinstance(cfg[key], dict):
                cfg[key].update(user_cfg[key])
            else:
                cfg[key] = user_cfg[key]
        return cfg
    return DEFAULT_CONFIG.copy()


# ─── Cloud API Methods ──────────────────────────────────

def parse_proxy(proxy):
    """Parse host:port:user:pass into CapMonster proxy fields."""
    if not proxy:
        return None

    parts = proxy.split(":")
    if len(parts) != 4:
        raise ValueError("Proxy must use host:port:user:pass format")

    host, port, username, password = parts
    if not host or not port or not username or not password:
        raise ValueError("Proxy host, port, username and password are required")

    return {
        "proxyType": "http",
        "proxyAddress": host,
        "proxyPort": int(port),
        "proxyLogin": username,
        "proxyPassword": password,
    }


def build_requests_proxies(proxy):
    """Build a requests-library proxies dict from host:port:user:pass.

    The solver's own API calls must go through the same proxy as the bot:
    on networks where direct outbound is blocked, api.capmonster.cloud is
    unreachable without it.
    """
    if not proxy:
        return None

    try:
        fields = parse_proxy(proxy)
    except ValueError:
        return None

    auth = f"{quote(fields['proxyLogin'], safe='')}:{quote(fields['proxyPassword'], safe='')}"
    proxy_url = f"http://{auth}@{fields['proxyAddress']}:{fields['proxyPort']}"
    return {"http": proxy_url, "https": proxy_url}


def post_create_task(api_url, payload, headers, retries, proxies=None):
    """Create CapMonster task with short retry loop for transient API/proxy errors."""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            print(f"  Creating captcha task on {api_url} (attempt {attempt}/{retries})...")
            resp = requests.post(f"{api_url}/createTask", json=payload, headers=headers, timeout=30, proxies=proxies)
            data = resp.json()

            if "taskId" in data:
                print(f"  Task ID: {data['taskId']}")
                return data["taskId"]

            last_error = Exception(f"Failed to create task: {data}")
        except Exception as e:
            last_error = e

        if attempt < retries:
            time.sleep(2 * attempt)

    raise last_error


def create_captcha_task_cloud(config, captcha_url, website_key, proxy=None):
    """Create a captcha solving task on CapMonster Cloud."""
    api_url = config["cloud"]["api_url"]
    headers = {"Content-Type": "application/json"}
    proxy_fields = parse_proxy(proxy)

    payload = {
        "clientKey": config["cloud"].get("api_key", ""),
        "task": {
            "type": "NoCaptchaTaskProxyless",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
        }
    }

    if proxy_fields:
        payload["task"] = {
            "type": "NoCaptchaTask",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
            **proxy_fields,
        }

    retries = config["solving"].get("task_create_retries", 3)
    return post_create_task(api_url, payload, headers, retries, build_requests_proxies(proxy))


def get_captcha_result_cloud(config, task_id, proxies=None):
    """Poll CapMonster Cloud for captcha result."""
    api_url = config["cloud"]["api_url"]
    headers = {"Content-Type": "application/json"}

    payload = {
        "clientKey": config["cloud"].get("api_key", ""),
        "taskId": task_id,
    }

    max_attempts = config["cloud"].get("timeout", 120) // config["cloud"].get("poll_interval", 3)
    
    for attempt in range(max_attempts):
        time.sleep(config["cloud"].get("poll_interval", 3))
        resp = requests.post(f"{api_url}/getTaskResult", json=payload, headers=headers, timeout=30, proxies=proxies)
        data = resp.json()

        status = data.get("status")
        if status == "ready":
            token = data["solution"]["token"]
            print(f"  ✓ Captcha solved! Token received ({attempt + 1} attempts)")
            return token
        elif status == "processing":
            remaining = max_attempts - attempt
            print(f"  ⏳ Solving... {remaining}s remaining")
        else:
            raise Exception(f"Unexpected status: {data}")

    raise TimeoutError("Captcha solving timed out")


# ─── Local Server Methods ────────────────────────────────

def create_captcha_task_local(config, captcha_url, website_key, proxy=None):
    """Create a captcha solving task on local CapMonster server."""
    server = config["local"]["server_url"]
    headers = {"Content-Type": "application/json"}
    proxy_fields = parse_proxy(proxy)

    payload = {
        "clientKey": config["local"].get("api_key", ""),
        "task": {
            "type": "NoCaptchaTaskProxyless",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
        }
    }

    if proxy_fields:
        payload["task"] = {
            "type": "NoCaptchaTask",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
            **proxy_fields,
        }

    retries = config["solving"].get("task_create_retries", 3)
    return post_create_task(server, payload, headers, retries)


def get_captcha_result_local(config, task_id, proxies=None):
    """Poll local CapMonster server for captcha result."""
    server = config["local"]["server_url"]
    headers = {"Content-Type": "application/json"}

    payload = {
        "clientKey": config["local"].get("api_key", ""),
        "taskId": task_id,
    }

    max_attempts = config["local"].get("timeout", 120) // config["local"].get("poll_interval", 3)

    for attempt in range(max_attempts):
        time.sleep(config["local"].get("poll_interval", 3))
        resp = requests.post(f"{server}/getTaskResult", json=payload, headers=headers, timeout=30, proxies=proxies)
        data = resp.json()

        status = data.get("status")
        if status == "ready":
            token = data["solution"]["token"]
            print(f"  ✓ Captcha solved! Token received ({attempt + 1} attempts)")
            return token
        elif status == "processing":
            remaining = max_attempts - attempt
            print(f"  ⏳ Solving... {remaining}s remaining")
        else:
            raise Exception(f"Unexpected status: {data}")

    raise TimeoutError("Captcha solving timed out")


# ─── Extract Yandex websiteKey ──────────────────────────

def extract_yandex_website_key(captcha_url, fallback_key=DEFAULT_WEBSITE_KEY):
    """Extract the actual website key from Yandex captcha page."""
    try:
        # Fetch the captcha page to get the real site key
        resp = requests.get(captcha_url, timeout=15, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        })
        
        # Look for sitekey in various patterns
        import re
        
        # Pattern 1: g-recaptcha data-sitekey
        match = re.search(r'data-sitekey=["\']([^"\']+)', resp.text)
        if match:
            key = match.group(1)
            print(f"  Extracted sitekey from page: {key[:20]}...")
            return key

        # Pattern 2: websiteKey in JS
        match = re.search(r'websiteKey["\']?\s*[:=]\s*["\']([^"\']+)', resp.text)
        if match:
            key = match.group(1)
            print(f"  Extracted websiteKey from page: {key[:20]}...")
            return key

        # Pattern 3: sitekey in script
        match = re.search(r'sitekey["\']?\s*[:=]\s*["\']([^"\']+)', resp.text)
        if match:
            key = match.group(1)
            print(f"  Extracted sitekey from page: {key[:20]}...")
            return key

    except Exception as e:
        print(f"  Warning: Could not extract sitekey from page: {e}")

    # Fallback to Yandex default
    return fallback_key


# ─── Main Solver ────────────────────────────────────────

def solve_captcha(captcha_url, config, sitekey=None):
    """Solve a Yandex captcha and return the token."""
    proxy = config["solving"].get("proxy_for_solving")

    # Use caller-provided dynamic sitekey first, then try fetching the captcha page.
    website_key = sitekey or extract_yandex_website_key(captcha_url)
    print(f"  Using sitekey: {website_key[:20]}...")

    # Update task with real key
    mode = config.get("mode", "cloud")

    req_proxies = build_requests_proxies(proxy)

    if mode == "cloud":
        task_id = create_captcha_task_cloud(config, captcha_url, website_key, proxy)
        token = get_captcha_result_cloud(config, task_id, req_proxies)
    elif mode == "local":
        task_id = create_captcha_task_local(config, captcha_url, website_key, proxy)
        token = get_captcha_result_local(config, task_id, req_proxies)
    else:
        raise ValueError(f"Unknown mode: {mode}")

    return token


def apply_token(page, token):
    """Apply the solved token to a Playwright browser page."""
    print("  Applying token to page...")
    
    # Yandex captcha expects the token in a specific field
    js_code = f"""
    (() => {{
        // Find and fill the captcha token input
        const inputs = document.querySelectorAll('input[type="hidden"], input[name="g-recaptcha-response"]');
        for (const input of inputs) {{
            if (input.name === 'g-recaptcha-response' || input.id.includes('recaptcha')) {{
                input.value = '{token}';
                input.dispatchEvent(new Event('change', {{bubbles: true}}));
            }}
        }}
        
        // Also try to find the token field by class/name patterns
        const fields = document.querySelectorAll('[class*="response"], [name*="response"], [name*="token"]');
        for (const field of fields) {{
            if (field.tagName === 'INPUT' && !field.value) {{
                field.value = '{token}';
                field.dispatchEvent(new Event('change', {{bubbles: true}}));
            }}
        }}

        // Click the submit button if found
        const buttons = document.querySelectorAll('button[type="submit"], input[type="submit"]');
        for (const btn of buttons) {{
            btn.click();
        }}
        
        return 'Token applied';
    }})()
    """
    
    return js_code


# ─── CLI Entry Point ────────────────────────────────────

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Solve Yandex captcha")
    parser.add_argument("--url", help="Yandex captcha page URL")
    parser.add_argument("--proxy", help="Proxy for solving: host:port:user:pass")
    parser.add_argument("--sitekey", help="Captcha website key extracted from the browser page")
    parser.add_argument("--output", default="json", choices=["json", "token"], 
                        help="Output format (default: json)")
    args = parser.parse_args()

    config = load_config()

    if args.proxy:
        config["solving"]["proxy_for_solving"] = args.proxy

    if not args.url:
        print("Usage: python solve_captcha.py --url <captcha_url>")
        sys.exit(1)

    captcha_url = args.url
    print(f"=== Yandex Captcha Solver ===")
    print(f"Captcha URL: {captcha_url}")
    print(f"Mode: {config.get('mode', 'cloud')}")
    print()

    try:
        token = solve_captcha(captcha_url, config, args.sitekey)
        
        if args.output == "json":
            result = {"token": token, "status": "success"}
            print(json.dumps(result))
        else:
            print(token)
            
    except Exception as e:
        if args.output == "json":
            result = {"error": str(e), "status": "failed"}
            print(json.dumps(result))
        else:
            print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
