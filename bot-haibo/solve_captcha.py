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
import warnings

warnings.filterwarnings(
    "ignore",
    message=r"urllib3 v2 only supports OpenSSL 1\.1\.1\+",
)

import requests
from pathlib import Path
from urllib.parse import urlparse, urljoin, quote

TRANSIENT_API_ERRORS = (
    requests.exceptions.ProxyError,
    requests.exceptions.SSLError,
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
)

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
        "route_api_via_proxy": False,
    },
}

CONFIG_PATH = Path(__file__).parent / "config" / "captcha.json"
REDACTION_SECRETS = []


def log(message):
    print(message, flush=True)


def remember_secret(value):
    if value:
        REDACTION_SECRETS.append(str(value))


def redact(value):
    text = str(value)
    for secret in REDACTION_SECRETS:
        text = text.replace(secret, "[REDACTED]")
    return text


def seconds_left(deadline, default_timeout=30):
    """Return a requests timeout that cannot exceed the solver wall-clock deadline."""
    if deadline is None:
        return default_timeout

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Captcha solver wall-clock timeout reached")

    return max(1, min(default_timeout, remaining))


def sleep_with_deadline(seconds, deadline=None):
    if deadline is None:
        time.sleep(seconds)
        return

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Captcha solver wall-clock timeout reached")

    time.sleep(min(seconds, remaining))


def request_json(method, url, *, label, deadline=None, timeout=30, **kwargs):
    """Run an HTTP request and return JSON with useful diagnostics on failure."""
    request_timeout = seconds_left(deadline, timeout)
    resp = requests.request(method, url, timeout=request_timeout, **kwargs)

    try:
        data = resp.json()
    except ValueError as e:
        preview = resp.text.replace("\n", " ")[:300]
        raise ValueError(f"{label} returned non-JSON HTTP {resp.status_code}: {preview}") from e

    if resp.status_code >= 400:
        raise RuntimeError(f"{label} returned HTTP {resp.status_code}: {data}")

    return data


def raise_api_error(label, data):
    error_code = data.get("errorCode") or "UNKNOWN_CAPMONSTER_ERROR"
    error_description = data.get("errorDescription") or data
    raise RuntimeError(f"{label} failed: {error_code}: {error_description}")


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


def config_shape(config):
    """Return config metadata without exposing secret values."""
    mode = config.get("mode", "cloud")
    mode_config = config.get(mode, {})
    return {
        "mode": mode,
        "api_url": mode_config.get("api_url") or mode_config.get("server_url"),
        "has_api_key": bool(mode_config.get("api_key")),
        "timeout": mode_config.get("timeout"),
        "poll_interval": mode_config.get("poll_interval"),
        "has_proxy_for_solving": bool(config.get("solving", {}).get("proxy_for_solving")),
        "route_api_via_proxy": bool(config.get("solving", {}).get("route_api_via_proxy", False)),
    }


def self_test(config=None):
    """Check imports and config parsing without creating a CapMonster task."""
    config = config or load_config()
    result = {
        "status": "ok",
        "python": sys.version.split()[0],
        "requests": getattr(requests, "__version__", "unknown"),
        "config": config_shape(config),
    }
    log(json.dumps(result))


# ─── Cloud API Methods ──────────────────────────────────

def parse_proxy(proxy):
    """Parse host:port:user:pass into CapMonster proxy fields."""
    if not proxy:
        return None
    if not isinstance(proxy, str):
        raise ValueError("Proxy must use host:port:user:pass format")

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
    """Build a requests-library proxies dict from host:port:user:pass."""
    if not proxy:
        return None

    try:
        fields = parse_proxy(proxy)
    except ValueError:
        return None

    auth = f"{quote(fields['proxyLogin'], safe='')}:{quote(fields['proxyPassword'], safe='')}"
    proxy_url = f"http://{auth}@{fields['proxyAddress']}:{fields['proxyPort']}"
    return {"http": proxy_url, "https": proxy_url}


def build_api_proxies(config, proxy):
    """Route CapMonster API calls directly by default.

    The proxy is still included in the CapMonster task payload so CapMonster
    can solve using the browser session IP. Only the Mac -> CapMonster API
    channel bypasses the flaky mobile proxy unless explicitly enabled.
    """
    if not config.get("solving", {}).get("route_api_via_proxy", False):
        return None
    return build_requests_proxies(proxy)


def post_create_task(api_url, payload, headers, retries, proxies=None, deadline=None):
    """Create CapMonster task with short retry loop for transient API/proxy errors."""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            log(f"  Creating captcha task on {api_url} (attempt {attempt}/{retries})...")
            data = request_json(
                "POST",
                f"{api_url}/createTask",
                label="createTask",
                deadline=deadline,
                json=payload,
                headers=headers,
                proxies=proxies,
            )

            if data.get("errorId") != 0:
                raise_api_error("createTask", data)

            task_id = data.get("taskId")
            if task_id:
                log(f"  Task ID: {data['taskId']}")
                return task_id

            last_error = Exception(f"Failed to create task: {data}")
        except Exception as e:
            last_error = e
            log(f"  createTask error: {e}")

        if attempt < retries:
            sleep_with_deadline(2 * attempt, deadline)

    raise last_error


def create_captcha_task_cloud(config, captcha_url, website_key, proxy=None, deadline=None, api_proxies=None):
    """Create a captcha solving task on CapMonster Cloud."""
    api_url = config["cloud"]["api_url"]
    headers = {"Content-Type": "application/json"}
    proxy_fields = parse_proxy(proxy)
    user_agent = config.get("solving", {}).get("user_agent")

    payload = {
        "clientKey": config["cloud"].get("api_key", ""),
        "task": {
            "type": "RecaptchaV2Task",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
        }
    }
    if user_agent:
        payload["task"]["userAgent"] = user_agent

    if proxy_fields:
        payload["task"] = {
            "type": "RecaptchaV2Task",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
            **proxy_fields,
        }
        if user_agent:
            payload["task"]["userAgent"] = user_agent

    retries = config["solving"].get("task_create_retries", 3)
    return post_create_task(api_url, payload, headers, retries, api_proxies, deadline)


def get_captcha_result_cloud(config, task_id, proxies=None, deadline=None):
    """Poll CapMonster Cloud for captcha result."""
    api_url = config["cloud"]["api_url"]
    headers = {"Content-Type": "application/json"}

    payload = {
        "clientKey": config["cloud"].get("api_key", ""),
        "taskId": task_id,
    }

    max_attempts = config["cloud"].get("timeout", 120) // config["cloud"].get("poll_interval", 3)
    
    for attempt in range(max_attempts):
        sleep_with_deadline(config["cloud"].get("poll_interval", 3), deadline)
        try:
            data = request_json(
                "POST",
                f"{api_url}/getTaskResult",
                label="getTaskResult",
                deadline=deadline,
                json=payload,
                headers=headers,
                proxies=proxies,
            )
        except TRANSIENT_API_ERRORS as e:
            remaining_attempts = max_attempts - attempt - 1
            log(f"  getTaskResult transport error for task {task_id}: {e}; keeping same task ({remaining_attempts} poll attempts remaining)")
            continue

        if data.get("errorId") not in (None, 0):
            raise_api_error("getTaskResult", data)

        status = data.get("status")
        if status == "ready":
            token = data["solution"]["token"]
            log(f"  ✓ Captcha solved! Token received ({attempt + 1} attempts)")
            return token
        elif status == "processing":
            remaining_attempts = max_attempts - attempt - 1
            log(f"  Solving... {remaining_attempts} poll attempts remaining")
        else:
            raise Exception(f"Unexpected status: {data}")

    raise TimeoutError("Captcha solving timed out")


# ─── Local Server Methods ────────────────────────────────

def create_captcha_task_local(config, captcha_url, website_key, proxy=None, deadline=None):
    """Create a captcha solving task on local CapMonster server."""
    server = config["local"]["server_url"]
    headers = {"Content-Type": "application/json"}
    proxy_fields = parse_proxy(proxy)
    user_agent = config.get("solving", {}).get("user_agent")

    payload = {
        "clientKey": config["local"].get("api_key", ""),
        "task": {
            "type": "RecaptchaV2Task",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
        }
    }
    if user_agent:
        payload["task"]["userAgent"] = user_agent

    if proxy_fields:
        payload["task"] = {
            "type": "RecaptchaV2Task",
            "websiteURL": captcha_url,
            "websiteKey": website_key,
            **proxy_fields,
        }
        if user_agent:
            payload["task"]["userAgent"] = user_agent

    retries = config["solving"].get("task_create_retries", 3)
    return post_create_task(server, payload, headers, retries, deadline=deadline)


def get_captcha_result_local(config, task_id, proxies=None, deadline=None):
    """Poll local CapMonster server for captcha result."""
    server = config["local"]["server_url"]
    headers = {"Content-Type": "application/json"}

    payload = {
        "clientKey": config["local"].get("api_key", ""),
        "taskId": task_id,
    }

    max_attempts = config["local"].get("timeout", 120) // config["local"].get("poll_interval", 3)

    for attempt in range(max_attempts):
        sleep_with_deadline(config["local"].get("poll_interval", 3), deadline)
        try:
            data = request_json(
                "POST",
                f"{server}/getTaskResult",
                label="getTaskResult",
                deadline=deadline,
                json=payload,
                headers=headers,
                proxies=proxies,
            )
        except TRANSIENT_API_ERRORS as e:
            remaining_attempts = max_attempts - attempt - 1
            log(f"  getTaskResult transport error for task {task_id}: {e}; keeping same task ({remaining_attempts} poll attempts remaining)")
            continue

        if data.get("errorId") not in (None, 0):
            raise_api_error("getTaskResult", data)

        status = data.get("status")
        if status == "ready":
            token = data["solution"]["token"]
            log(f"  ✓ Captcha solved! Token received ({attempt + 1} attempts)")
            return token
        elif status == "processing":
            remaining_attempts = max_attempts - attempt - 1
            log(f"  Solving... {remaining_attempts} poll attempts remaining")
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
            log(f"  Extracted sitekey from page: {key[:20]}...")
            return key

        # Pattern 2: websiteKey in JS
        match = re.search(r'websiteKey["\']?\s*[:=]\s*["\']([^"\']+)', resp.text)
        if match:
            key = match.group(1)
            log(f"  Extracted websiteKey from page: {key[:20]}...")
            return key

        # Pattern 3: sitekey in script
        match = re.search(r'sitekey["\']?\s*[:=]\s*["\']([^"\']+)', resp.text)
        if match:
            key = match.group(1)
            log(f"  Extracted sitekey from page: {key[:20]}...")
            return key

    except Exception as e:
        log(f"  Warning: Could not extract sitekey from page: {e}")

    # Fallback to Yandex default
    return fallback_key


# ─── Main Solver ────────────────────────────────────────

def solve_captcha(captcha_url, config, sitekey=None):
    """Solve a Yandex captcha and return the token."""
    proxy = config["solving"].get("proxy_for_solving")
    mode = config.get("mode", "cloud")
    mode_config = config.get(mode, {})
    wall_timeout = int(mode_config.get("timeout", 120))
    deadline = time.monotonic() + wall_timeout

    # Use caller-provided dynamic sitekey first, then try fetching the captcha page.
    website_key = sitekey or extract_yandex_website_key(captcha_url)
    log(f"  Using sitekey: {website_key[:20]}...")
    log(f"  Solver wall-clock timeout: {wall_timeout}s")

    # Update task with real key
    api_proxies = build_api_proxies(config, proxy)
    log(f"  CapMonster API transport: {'proxy' if api_proxies else 'direct'}")
    log(f"  CapMonster task proxy: {'yes' if proxy else 'no'}")

    if mode == "cloud":
        task_id = create_captcha_task_cloud(config, captcha_url, website_key, proxy, deadline, api_proxies)
        token = get_captcha_result_cloud(config, task_id, api_proxies, deadline)
    elif mode == "local":
        task_id = create_captcha_task_local(config, captcha_url, website_key, proxy, deadline)
        token = get_captcha_result_local(config, task_id, None, deadline)
    else:
        raise ValueError(f"Unknown mode: {mode}")

    return token


def apply_token(page, token):
    """Apply the solved token to a Playwright browser page."""
    log("  Applying token to page...")
    
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
    parser.add_argument("--self-test", action="store_true", help="Check Python/import/config startup without solving")
    parser.add_argument("--output", default="json", choices=["json", "token"], 
                        help="Output format (default: json)")
    args = parser.parse_args()

    config = load_config()

    if args.proxy:
        config["solving"]["proxy_for_solving"] = args.proxy
        remember_secret(args.proxy)
        try:
            fields = parse_proxy(args.proxy)
            remember_secret(fields.get("proxyLogin"))
            remember_secret(fields.get("proxyPassword"))
        except ValueError:
            pass

    if args.self_test:
        self_test(config)
        return

    if not args.url:
        log("Usage: python solve_captcha.py --url <captcha_url>")
        sys.exit(1)

    captcha_url = args.url
    log(f"=== Yandex Captcha Solver ===")
    log(f"Captcha URL: {captcha_url}")
    log(f"Mode: {config.get('mode', 'cloud')}")
    log("")

    try:
        token = solve_captcha(captcha_url, config, args.sitekey)
        
        if args.output == "json":
            result = {"token": token, "status": "success"}
            log(json.dumps(result))
        else:
            log(token)
            
    except Exception as e:
        if args.output == "json":
            result = {"error": redact(e), "error_type": type(e).__name__, "status": "failed"}
            log(json.dumps(result))
        else:
            log(f"ERROR: {redact(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
