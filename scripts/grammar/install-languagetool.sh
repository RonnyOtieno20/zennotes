#!/usr/bin/env bash

set -euo pipefail

download_url="${LANGUAGETOOL_DOWNLOAD_URL:-https://languagetool.org/download/LanguageTool-6.6.zip}"
data_dir="${HOME}/.local/share/zennotes/languagetool"
config_dir="${HOME}/.config/zennotes/languagetool"
user_unit_dir="${HOME}/.config/systemd/user"
service_name="zennotes-languagetool.service"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

for command_name in curl unzip java systemctl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

mkdir -p "${data_dir}" "${config_dir}" "${user_unit_dir}"
touch "${config_dir}/server.properties"

if [[ ! -f "${data_dir}/current/languagetool-server.jar" ]]; then
  temporary_dir="$(mktemp -d)"
  trap 'rm -rf -- "${temporary_dir}"' EXIT

  archive_path="${temporary_dir}/languagetool.zip"
  echo "Downloading LanguageTool from ${download_url}"
  curl --fail --location --retry 3 --output "${archive_path}" "${download_url}"
  unzip -q "${archive_path}" -d "${temporary_dir}/unpacked"

  extracted_dir="$(find "${temporary_dir}/unpacked" -mindepth 1 -maxdepth 1 -type d -name 'LanguageTool-*' -print -quit)"
  if [[ -z "${extracted_dir}" || ! -f "${extracted_dir}/languagetool-server.jar" ]]; then
    echo "The downloaded archive does not contain a LanguageTool server." >&2
    exit 1
  fi

  release_dir="${data_dir}/$(basename -- "${extracted_dir}")"
  if [[ ! -d "${release_dir}" ]]; then
    mv -- "${extracted_dir}" "${release_dir}"
  fi
  ln -sfn -- "${release_dir}" "${data_dir}/current"
else
  echo "Using the existing LanguageTool installation at ${data_dir}/current"
fi

install -m 0644 \
  "${repo_root}/packaging/systemd/zennotes-languagetool.service" \
  "${user_unit_dir}/${service_name}"

systemctl --user daemon-reload
systemctl --user enable --now "${service_name}"

for _ in {1..30}; do
  if curl --fail --silent \
    "http://127.0.0.1:8081/v2/languages" >/dev/null; then
    echo "LanguageTool is ready at http://127.0.0.1:8081/v2"
    exit 0
  fi
  sleep 1
done

echo "LanguageTool did not become ready within 30 seconds." >&2
systemctl --user --no-pager --full status "${service_name}" >&2 || true
exit 1
