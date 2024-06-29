#!/usr/bin/env python3
r"""Download a Kaggle kernel's output without loading it into memory.

The Kaggle CLI downloads kernel output with `out.write(download_response.content)`,
which reads the whole file into RAM before writing it to disk. On this kernel the
output contains three 511 MB `optimizer.pt` checkpoints, so the CLI peaks above
1.5 GB of resident memory and the 7 GB box starts swapping and stalling.

This script does the same job the safe way:

  * it lists the output files through the API and keeps only the ones matching
    `--include` (by default the two result archives and the run log),
  * it streams each file to disk in 1 MB chunks, so resident memory stays flat
    no matter how large the file is,
  * it resumes a partial download with a Range request instead of starting over,
    and it retries a broken transfer without discarding what was already
    fetched.

Usage:
    python3 scripts/kaggle/kaggle-fetch-output.py \
        --kernel cptadityavyas/invisiphish-training-and-evaluation \
        --dest research/kaggle/output \
        --include '^(invisiphish-(model|results)\.zip|invisiphish-training-and-evaluation\.log)$'
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time

import requests

CHUNK = 1024 * 1024
DEFAULT_INCLUDE = (
    r"^(invisiphish-(model|results)\.zip|invisiphish-training-and-evaluation\.log)$"
)


def build_client():
    from kaggle.api.kaggle_api_extended import KaggleApi

    api = KaggleApi()
    api.authenticate()
    return api


def list_output_files(api, kernel, page_size: int = 200, retries: int = 6):
    """Return every output file as (name, url), following the pagination.

    The Kaggle API rate-limits with a 429 when several downloads are started in
    quick succession, so a throttled listing is retried with a growing delay
    rather than aborting the whole fetch.
    """
    from kagglesdk.kernels.types.kernels_api_service import (
        ApiListKernelSessionOutputRequest,
    )

    owner_slug, kernel_slug, _version = api.parse_kernel_string(kernel)
    files = []
    token = None
    with api.build_kaggle_client() as kaggle:
        while True:
            request = ApiListKernelSessionOutputRequest()
            request.user_name = owner_slug
            request.kernel_slug = kernel_slug
            api._set_paging(request, page_size, token)

            response = None
            for attempt in range(1, retries + 1):
                try:
                    response = (
                        kaggle.kernels.kernels_api_client.list_kernel_session_output(
                            request
                        )
                    )
                    break
                except Exception as exc:  # noqa: BLE001
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    if status != 429 or attempt == retries:
                        raise
                    delay = min(15 * attempt, 90)
                    print(
                        f"    rate limited (429), retrying in {delay}s",
                        file=sys.stderr,
                    )
                    time.sleep(delay)
            if response is None:
                raise RuntimeError("could not list the kernel output")

            for item in response.files or []:
                files.append((item.file_name, item.url))
            token = response.next_page_token
            if not token:
                break
    return files


def download_stream(url: str, dest: str, retries: int = 5) -> int:
    """Stream one URL to dest, resuming and retrying on a broken transfer."""
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or ".", exist_ok=True)

    for attempt in range(1, retries + 1):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with requests.get(url, stream=True, timeout=120, headers=headers) as response:
                if response.status_code == 416:
                    # The file is already complete on disk: the server has no
                    # byte past the end. Nothing left to fetch.
                    return have
                if have and response.status_code == 200:
                    # The server ignored the Range header: start over.
                    have = 0
                response.raise_for_status()
                mode = "ab" if have and response.status_code == 206 else "wb"
                with open(dest, mode) as out:
                    for chunk in response.iter_content(chunk_size=CHUNK):
                        if chunk:
                            out.write(chunk)
            return os.path.getsize(dest)
        except Exception as exc:  # noqa: BLE001 - any transport error is retryable
            size = os.path.getsize(dest) if os.path.exists(dest) else 0
            print(
                f"    attempt {attempt}/{retries} failed at {size / 1e6:.1f} MB: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            if attempt == retries:
                raise
            time.sleep(min(5 * attempt, 20))

    return 0


def fetch_log(api, kernel, dest_dir: str) -> int:
    """Save the kernel's run log.

    The log is not one of the output *files*: the API returns it as a separate
    field on the session-output response, which is why a file-pattern fetch
    never picks it up.
    """
    from kagglesdk.kernels.types.kernels_api_service import (
        ApiListKernelSessionOutputRequest,
    )

    owner_slug, kernel_slug, _version = api.parse_kernel_string(kernel)
    with api.build_kaggle_client() as kaggle:
        request = ApiListKernelSessionOutputRequest()
        request.user_name = owner_slug
        request.kernel_slug = kernel_slug
        api._set_paging(request, 1, None)
        response = kaggle.kernels.kernels_api_client.list_kernel_session_output(request)

    log = response.log
    if not log:
        return 0

    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, f"{kernel_slug}.log")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(log)
    return len(log)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--kernel",
        default="cptadityavyas/invisiphish-training-and-evaluation",
        help="owner/kernel-slug",
    )
    parser.add_argument("--dest", default="research/kaggle/output", help="destination directory")
    parser.add_argument(
        "--include",
        default=DEFAULT_INCLUDE,
        help="regex the file name must match; the default keeps only the two "
        "archives and the log, and skips the multi-hundred-megabyte checkpoints",
    )
    parser.add_argument(
        "--exclude",
        default=r"^_runs/",
        help="regex for paths to skip entirely",
    )
    parser.add_argument(
        "--no-log",
        action="store_true",
        help="do not fetch the run log",
    )
    parser.add_argument("--list-only", action="store_true", help="list and exit")
    args = parser.parse_args()

    api = build_client()
    files = list_output_files(api, args.kernel)

    include = re.compile(args.include)
    exclude = re.compile(args.exclude)

    wanted = []
    for name, url in files:
        if exclude.search(name):
            continue
        if include.search(name):
            wanted.append((name, url))

    skipped = len(files) - len(wanted)
    print(f"{len(files)} output files, {len(wanted)} wanted, {skipped} skipped")

    if args.list_only:
        for name, _url in wanted:
            print(f"  {name}")
        return 0

    for name, url in wanted:
        dest = os.path.join(args.dest, name)
        print(f"  -> {name}")
        size = download_stream(url, dest)
        print(f"     {size / 1e6:.1f} MB at {dest}")

    if not args.no_log:
        length = fetch_log(api, args.kernel, args.dest)
        if length:
            print(f"  -> run log ({length / 1e6:.1f} MB)")

    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
