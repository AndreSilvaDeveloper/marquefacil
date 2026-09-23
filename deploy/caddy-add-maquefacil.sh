#!/usr/bin/env bash
# Acrescenta o maquefacil.com.br no Caddy COMPARTILHADO da máquina nd2 (rodar como root lá).
# Uso a partir de outra máquina:  ssh root@100.85.80.113 bash -s < deploy/caddy-add-maquefacil.sh
#
# Seguro para os outros sites: faz backup, só acrescenta no fim, valida antes de aplicar
# (se falhar, restaura o backup) e usa `caddy reload`, que não derruba nada.
set -e
F=/var/www/caddy/Caddyfile

if grep -q 'maquefacil.com.br' "$F"; then echo "O bloco já existe. Nada a fazer."; exit 0; fi

B="$F.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$F" "$B" && echo "Backup: $B"

# ">>" mantém o mesmo arquivo (o container do Caddy enxerga a mudança pelo bind mount)
cat >> "$F" <<'BLOCK'

# Marque Fácil (app em /opt/marquefacil, container marquefacil-app na rede "marquefacil")
maquefacil.com.br, www.maquefacil.com.br {
	import security_headers
	encode zstd gzip
	reverse_proxy marquefacil-app:3000
}
BLOCK

if docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /tmp/caddy-validate.log 2>&1; then
  echo "Validação OK"
else
  echo "VALIDAÇÃO FALHOU — restaurando o backup, nada foi aplicado:"
  tail -5 /tmp/caddy-validate.log
  cat "$B" > "$F"
  exit 1
fi

docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
echo "Pronto: Caddy recarregado. O certificado HTTPS sai sozinho em alguns segundos."
