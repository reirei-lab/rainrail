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
require_command tar

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Rainrail requires Node.js 20 or newer." >&2
  exit 1
fi

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
  basename "${effective_url}" | sed -e 's/^v//' -e 's#^release/##' -e 's#^release%2F##' -e 's#^release%2f##'
}

if [ -z "${asset_url}" ]; then
  if [ -z "${version}" ]; then
    version="$(resolve_latest_version)"
  fi
  version="${version#v}"
  version="${version#release/}"
  version="${version#release%2F}"
  version="${version#release%2f}"
  asset_url="https://github.com/${repo}/releases/download/release%2F${version}/rainrail-cli-v${version}.tgz"
fi

tmpdir="$(mktemp -d)"
staging_dir=""
cleanup() {
  if [ -n "${staging_dir}" ]; then
    rm -rf "${staging_dir}"
  fi
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
target_parent="$(dirname "${target_dir}")"
bin_path="${bin_dir}/rainrail"
mkdir -p "${target_parent}" "${bin_dir}"
if [ -d "${bin_path}" ] && [ ! -L "${bin_path}" ]; then
  echo "Cannot replace existing directory at ${bin_path}." >&2
  exit 1
fi

staging_dir="$(mktemp -d "${target_parent}/.${installed_version}.XXXXXX")"
cp -R "${package_dir}/." "${staging_dir}/"
chmod +x "${staging_dir}/dist/bin/rainrail.js"

backup_dir=""
if [ -e "${target_dir}" ]; then
  backup_dir="${target_parent}/.${installed_version}.backup.$$"
  rm -rf "${backup_dir}"
  mv "${target_dir}" "${backup_dir}"
fi
if mv "${staging_dir}" "${target_dir}"; then
  staging_dir=""
  if [ -n "${backup_dir}" ]; then
    rm -rf "${backup_dir}"
  fi
else
  if [ -n "${backup_dir}" ] && [ -e "${backup_dir}" ]; then
    mv "${backup_dir}" "${target_dir}"
  fi
  exit 1
fi
ln -sfn "../lib/rainrail/${installed_version}/dist/bin/rainrail.js" "${bin_path}"

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
  if [ -z "${HOME:-}" ]; then
    echo "Skipping shell rc update because HOME is not set." >&2
    exit 0
  fi

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
