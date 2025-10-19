# Guia de Instalação do REVAMP Identifier

Este documento explica, passo a passo, como preparar o ambiente para executar o bot REVAMP Identifier, desde a criação da aplicação no Discord até à aplicação de um backup da base de dados PostgreSQL.

## 1. Requisitos

- Servidor ou máquina com Ubuntu/Debian (ou outro sistema compatível) com acesso à Internet.
- Node.js 18 LTS ou superior.
- PostgreSQL 11 ou superior.
- Conta com permissões de administrador no servidor Discord onde o bot irá atuar.
- Acesso ao ficheiro de backup da base de dados (`.sql` ou `.dump`) quando for necessário restaurar os dados.

### 1.1 Instalar dependências de sistema (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install -y curl git build-essential
```

### 1.2 Instalar Node.js 18 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

### 1.3 Instalar PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

## 2. Criar aplicação e bot no Discord

1. Acede a <https://discord.com/developers/applications> e inicia sessão.
2. Clica em **New Application**, define um nome (ex.: `REVAMP Identifier`) e aceita os termos.
3. Na barra lateral, abre a secção **Bot** e clica em **Add Bot**.
4. Copia o **Token** do bot e guarda-o para mais tarde (`DISCORD_TOKEN`).
5. Ainda em **Bot**, ativa as **Privileged Gateway Intents**:
   - **SERVER MEMBERS INTENT**
   - **MESSAGE CONTENT INTENT**
   Guarda as alterações.
6. Em **OAuth2 → General**, copia o **Application ID** (`DISCORD_CLIENT_ID`).
7. (Opcional) Copia também o **Public Key** caso pretendas utilizar interações HTTP (não é necessário para este projeto).
8. Gera o link de convite do bot substituindo `CLIENT_ID` pelo teu Application ID:
   ```text
   https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=402654208&scope=bot%20applications.commands
   ```
9. Utiliza o link para convidar o bot para o servidor desejado. Garante que a role do bot fica acima das roles que precisará de gerir e que o bot tem as permissões **Manage Nicknames**, **Manage Roles**, **Read Member List** e **Send Messages**.

## 3. Preparar o repositório do bot

1. Clona o projeto para a máquina onde o bot irá correr:
   ```bash
   git clone https://github.com/seu-utilizador/REVAMP_identifier.git
   cd REVAMP_identifier
   ```
2. Instala as dependências Node.js:
   ```bash
   npm install
   ```
3. Cria o ficheiro `.env` a partir do exemplo:
   ```bash
   cp .env.example .env
   ```
4. Edita o `.env` com os valores reais:
   - `DISCORD_TOKEN`: token copiado do Developer Portal.
   - `DISCORD_CLIENT_ID`: Application ID.
   - `GUILD_ID`: ID do servidor onde o bot irá operar (ativa o Developer Mode no Discord, clica com o botão direito no servidor → **Copy ID**).
   - Configurações de PostgreSQL (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`).
   - Configuração de staff (`STAFF_ROLE_IDS`, `NICKNAME_PREFIX_BRACKETS`) conforme as regras do teu servidor.

## 4. Configurar PostgreSQL

1. Cria o utilizador e a base de dados (ajusta os nomes e palavra-passe conforme necessário):
   ```bash
   sudo -u postgres psql -c "CREATE USER revamp WITH PASSWORD 'muda_isto';"
   sudo -u postgres psql -c "CREATE DATABASE revampadmin OWNER revamp;"
   ```
2. Concede privilégios adicionais se necessário:
   ```bash
   sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE revampadmin TO revamp;"
   ```
3. Aplica o esquema inicial utilizando o ficheiro `schema.sql` incluído no repositório:
   ```bash
   psql "postgresql://revamp:muda_isto@127.0.0.1:5432/revampadmin" -f schema.sql
   ```

## 5. Restaurar um backup da base de dados

Dependendo do formato do backup que recebeste, utiliza um dos métodos seguintes.

### 5.1 Backup em formato SQL (`*.sql`)

```bash
psql "postgresql://revamp:muda_isto@127.0.0.1:5432/revampadmin" -f caminho/para/backup.sql
```

### 5.2 Backup em formato pg_dump personalizado (`*.dump` ou `*.tar`)

```bash
pg_restore \
  --clean \
  --no-owner \
  --no-privileges \
  --dbname="postgresql://revamp:muda_isto@127.0.0.1:5432/revampadmin" \
  caminho/para/backup.dump
```

- `--clean` remove objetos existentes antes de restaurar.
- `--no-owner` e `--no-privileges` evitam conflitos de permissões ao restaurar.

> **Nota:** certifica-te que o utilizador configurado no `.env` tem permissões para criar/alterar objetos no esquema `discord_tags`.

Após restaurar, confirma se os dados foram importados corretamente:

```bash
psql "postgresql://revamp:muda_isto@127.0.0.1:5432/revampadmin" -c "SELECT COUNT(*) FROM discord_tags.user_tags;"
```

## 6. Registar comandos e testar o bot

1. Atualiza/regista os Slash Commands no servidor configurado:
   ```bash
   npm run deploy
   ```
2. Inicia o bot em modo de desenvolvimento/local:
   ```bash
   node index.js
   ```
3. Verifica a consola para garantir que o bot se liga sem erros. No Discord, os comandos `/verificar`, `/aplicar`, `/aplicastaff`, `/reset`, `/staff`, `/corrigir` e `/comunicado` devem aparecer disponíveis para administradores.

## 7. Executar o bot em produção (opcional)

Para manter o bot a correr continuamente, cria um serviço `systemd`.

1. Edita o ficheiro `/etc/systemd/system/revamp-identifier.service` com o seguinte conteúdo (ajusta os caminhos):
   ```ini
   [Unit]
   Description=REVAMP Discord Bot
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/opt/REVAMP_identifier
   ExecStart=/usr/bin/node index.js
   Restart=always
   EnvironmentFile=/opt/REVAMP_identifier/.env

   [Install]
   WantedBy=multi-user.target
   ```
2. Recarrega o `systemd` e ativa o serviço:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now revamp-identifier
   sudo journalctl -u revamp-identifier -f
   ```

## 8. Atualizações e manutenção

- Para atualizar o bot:
  ```bash
  cd /opt/REVAMP_identifier
  git pull
  npm install
  npm run deploy
  sudo systemctl restart revamp-identifier
  ```
- Para efetuar backups regulares da base de dados:
  ```bash
  pg_dump --format=custom --file=/caminho/para/backups/revamp_$(date +%F).dump \
    "postgresql://revamp:muda_isto@127.0.0.1:5432/revampadmin"
  ```

Seguindo estes passos, o bot REVAMP Identifier ficará configurado com todas as permissões necessárias e com os dados restaurados a partir do backup fornecido.
