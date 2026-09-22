# Minha Agenda — salão de beleza

App simples de celular para a profissional ver e marcar horários, acompanhar clientes e o dinheiro.
Funciona **sem internet** e **sem servidor**: os dados ficam guardados no próprio celular.

## O que faz
- **Agenda**: dia a dia, com setas e a semana em cima. Botão **+ Agendar**.
- **Agendar**: só precisa do **nome** e do **horário**. Serviço, tempo, valor e "já pagou?" são opcionais.
  - Cliente nova é cadastrada sozinha. Serviço novo fica salvo na lista (com tempo e valor).
  - Se o horário já estiver ocupado, aparece um **aviso**, mas dá para agendar mesmo assim.
- **Clientes**: busca, dados, WhatsApp, histórico de serviços e produtos, quanto já pagou e quanto falta.
  Dá para colocar o valor e marcar **"Recebi"** direto no histórico.
- **Vender produto**: igual ao agendamento — cliente e produto novos são cadastrados sozinhos.
- **Dinheiro**: recebido no mês (serviços / produtos), quem está devendo, atendimentos sem valor.
- **Buscar**: por nome, serviço, produto ou data (ex.: 15/09).
- **Mais**: lista de serviços e produtos, **letra grande**, e **cópia de segurança**.

## Rodar no computador
```bash
python3 -m http.server 8000
# abrir http://localhost:8000
```

## Colocar no celular
Publique a pasta em qualquer hospedagem estática com HTTPS (GitHub Pages, Netlify, Cloudflare Pages…),
abra o link no celular e escolha **"Adicionar à tela inicial"** / **"Instalar app"**.

> Os dados ficam só naquele celular/navegador. Use **Mais → Fazer cópia de segurança** de vez em quando
> e mande o arquivo para o WhatsApp/e-mail. Para trocar de celular, use **Recuperar de uma cópia**.

Ao alterar arquivos do app, aumente a versão `CACHE` em `sw.js` para os celulares pegarem a atualização.
