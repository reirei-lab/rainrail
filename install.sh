#!/usr/bin/env bash
set -euo pipefail

repo="reirei-lab/rainrail"
version=""
asset_url=""
prefix="${RAINRAIL_PREFIX:-}"
add_to_shell="false"
assume_yes="false"

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Options:
  --version <x.y.z>     Install a specific Rainrail CLI release.
  --asset-url <url>     Install from an explicit tgz URL. Intended for tests.
  --prefix <path>       Install under this user-local prefix. Defaults to ~/.rainrail.
  --repo <owner/repo>   GitHub repository to install from. Defaults to reirei-lab/rainrail.
  --add-to-shell        Offer to add the Rainrail bin directory to your shell rc file.
  --yes                Answer yes to non-interactive prompts.
  --help               Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      version="${2:-}"
      if [ -z "${version}" ]; then
        echo "Missing value for --version." >&2
        exit 1
      fi
      shift 2
      ;;
    --asset-url)
      asset_url="${2:-}"
      if [ -z "${asset_url}" ]; then
        echo "Missing value for --asset-url." >&2
        exit 1
      fi
      shift 2
      ;;
    --prefix)
      prefix="${2:-}"
      if [ -z "${prefix}" ]; then
        echo "Missing value for --prefix." >&2
        exit 1
      fi
      shift 2
      ;;
    --repo)
      repo="${2:-}"
      if [ -z "${repo}" ]; then
        echo "Missing value for --repo." >&2
        exit 1
      fi
      shift 2
      ;;
    --add-to-shell)
      add_to_shell="true"
      shift
      ;;
    --yes)
      assume_yes="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "${prefix}" ]; then
  if [ -z "${HOME:-}" ]; then
    echo "HOME is not set. Pass --prefix <path> or set RAINRAIL_PREFIX." >&2
    exit 1
  fi
  prefix="${HOME}/.rainrail"
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Rainrail requires $1, but it was not found on PATH." >&2
    exit 1
  fi
}

require_command node
require_command npm
require_command tar

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Rainrail requires Node.js 20 or newer." >&2
  exit 1
fi

npm_version="$(npm --version 2>/dev/null || true)"
if [ -z "${npm_version}" ]; then
  echo "Rainrail requires a working npm or npm-compatible installer command." >&2
  exit 1
fi

npm_major="${npm_version%%.*}"
case "${npm_major}" in
  ''|*[!0-9]*)
    echo "Rainrail could not determine the npm-compatible installer version: ${npm_version}" >&2
    exit 1
    ;;
  *)
    if [ "${npm_major}" -lt 9 ]; then
      echo "Rainrail requires npm or an npm-compatible installer version 9 or newer." >&2
      exit 1
    fi
    ;;
esac

download() {
  local url="$1"
  local output="$2"

  case "${url}" in
    file://*)
      cp "${url#file://}" "${output}"
      ;;
    *)
      require_command curl
      curl -fsSL "${url}" -o "${output}"
      ;;
  esac
}

shell_escape() {
  printf '%q' "$1"
}

resolve_latest_version() {
  require_command curl
  local effective_url
  effective_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${repo}/releases/latest")"
  basename "${effective_url}" | sed 's/^v//'
}

if [ -z "${asset_url}" ]; then
  if [ -z "${version}" ]; then
    version="$(resolve_latest_version)"
  fi
  version="${version#v}"
  asset_url="https://github.com/${repo}/releases/download/v${version}/rainrail-cli-v${version}.tgz"
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

tarball="${tmpdir}/rainrail-cli.tgz"
extract_dir="${tmpdir}/extract"
mkdir -p "${extract_dir}"
download "${asset_url}" "${tarball}"
tar -xzf "${tarball}" -C "${extract_dir}"

package_dir="${extract_dir}/package"
if [ ! -f "${package_dir}/package.json" ]; then
  echo "Release asset did not contain package/package.json." >&2
  exit 1
fi

installed_version="$(
  node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.version);' \
    "${package_dir}/package.json"
)"

if [[ ! "${installed_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Release asset package version is invalid: ${installed_version}" >&2
  exit 1
fi

target_dir="${prefix}/lib/rainrail/${installed_version}"
bin_dir="${prefix}/bin"
path_line="export PATH=$(shell_escape "${bin_dir}"):\$PATH"
mkdir -p "${target_dir}" "${bin_dir}"
rm -rf "${target_dir}"
mkdir -p "$(dirname "${target_dir}")"
cp -R "${package_dir}" "${target_dir}"
chmod +x "${target_dir}/dist/bin/rainrail.js"
ln -sfn "../lib/rainrail/${installed_version}/dist/bin/rainrail.js" "${bin_dir}/rainrail"

echo "Installed Rainrail CLI ${installed_version} to ${target_dir}"

case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *)
    echo "${bin_dir} is not on PATH."
    echo "Add this line to your shell rc file:"
    echo "  ${path_line}"
    ;;
esac

if [ "${add_to_shell}" = "true" ]; then
  shell_name="$(basename "${SHELL:-}")"
  case "${shell_name}" in
    zsh) rc_file="${HOME}/.zshrc" ;;
    bash) rc_file="${HOME}/.bashrc" ;;
    *) rc_file="${HOME}/.profile" ;;
  esac

  should_edit="${assume_yes}"
  if [ "${should_edit}" != "true" ]; then
    printf 'Add Rainrail to PATH in %s? [y/N] ' "${rc_file}"
    if IFS= read -r answer; then
      case "${answer}" in
        y|Y|yes|YES) should_edit="true" ;;
      esac
    fi
  fi

  if [ "${should_edit}" = "true" ]; then
    touch "${rc_file}"
    if ! grep -F "${path_line}" "${rc_file}" >/dev/null 2>&1; then
      printf '\n%s\n' "${path_line}" >> "${rc_file}"
      echo "Updated ${rc_file}"
    fi
  fi
fi
