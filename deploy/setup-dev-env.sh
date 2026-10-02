#!/usr/bin/env bash
# Prepara o AMBIENTE DE TESTES (branch dev) na máquina nd2. Rodar uma vez, como root lá:
#   ssh root@100.85.80.113 bash -s < deploy/setup-dev-env.sh
#
# 1) cria /opt/marquefacil-dev (do usuário do runner);
# 2) acrescenta no FIM do Caddyfile compartilhado o bloco de dev.maquefacil.com.br e dev.studiokadosh.com
#    → container marquefacil-dev-app. Faz backup, valida antes de aplicar (se falhar, restaura) e usa
#    `caddy reload`, que não derruba os outros sites. Não recria o Caddy.
# Não mexe em nada da produção (/opt/marquefacil, containers marquefacil-*).
set -e
F=/var/www/caddy/Caddyfile
DIR=/opt/marquefacil-dev

if [ -d "$DIR" ]; then echo "$DIR já existe"; else mkdir -p "$DIR" && echo "Criado $DIR"; fi
chown ghrunner:ghrunner "$DIR"

if grep -q 'dev\.maquefacil\.com\.br' "$F"; then
  echo "O bloco do dev já está no Caddy. Nada a fazer."
  exit 0
fi

B="$F.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$F" "$B" && echo "Backup: $B"

# ">>" mantém o mesmo arquivo (o container do Caddy enxerga a mudança pelo bind mount)
cat >> "$F" <<'BLOCK'

# Marque Fácil — ambiente de testes (app em /opt/marquefacil-dev, container marquefacil-dev-app na rede "marquefacil-dev")
dev.maquefacil.com.br, dev.studiokadosh.com {
	import security_headers
	encode zstd gzip
	reverse_proxy marquefacil-dev-app:3000
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
echo "Pronto. Falta só o DNS: registro A 'dev' → 77.37.40.221 nos dois domínios."
echo "O certificado HTTPS sai sozinho quando o DNS estiver apontando e o primeiro deploy do dev tiver rodado."
