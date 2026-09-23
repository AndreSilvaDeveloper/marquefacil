#!/usr/bin/env bash
# Faz mais um domínio abrir o Marque Fácil, no Caddy COMPARTILHADO da máquina nd2 (rodar como root lá).
# Uso a partir de outra máquina:
#   ssh root@100.85.80.113 bash -s -- studiokadosh.com < deploy/caddy-add-domain.sh
#
# Acrescenta "dominio, www.dominio" na linha do bloco do maquefacil.com.br (criado por
# caddy-add-maquefacil.sh). Faz backup, valida antes de aplicar (se falhar, restaura) e usa
# `caddy reload`, que não derruba os outros sites.
set -e
D="${1,,}"
F=/var/www/caddy/Caddyfile
[[ "$D" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || { echo "Uso: $0 dominio.com"; exit 1; }

LINE=$(grep -nE '^maquefacil\.com\.br, www\.maquefacil\.com\.br.*\{' "$F" | cut -d: -f1)
[ -n "$LINE" ] || { echo "Não achei o bloco do maquefacil.com.br. Rode antes caddy-add-maquefacil.sh."; exit 1; }
if sed -n "${LINE}p" "$F" | grep -qE "(^|[ ,])${D//./\\.}([ ,]|$)"; then echo "$D já está no bloco. Nada a fazer."; exit 0; fi

B="$F.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$F" "$B" && echo "Backup: $B"

# Monta o arquivo novo e escreve POR CIMA do mesmo arquivo (o container enxerga pelo bind mount;
# "sed -i" criaria outro arquivo e o Caddy continuaria vendo o antigo)
TMP=$(mktemp)
sed "${LINE}s/ *{\$/, ${D}, www.${D} {/" "$F" > "$TMP"
cat "$TMP" > "$F"; rm -f "$TMP"
echo "Linha agora: $(sed -n "${LINE}p" "$F")"

if docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /tmp/caddy-validate.log 2>&1; then
  echo "Validação OK"
else
  echo "VALIDAÇÃO FALHOU — restaurando o backup, nada foi aplicado:"
  tail -5 /tmp/caddy-validate.log
  cat "$B" > "$F"
  exit 1
fi

docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
echo "Pronto: $D e www.$D apontam para o Marque Fácil. O certificado HTTPS sai sozinho em alguns segundos."
