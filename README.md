# Ghost Hub

![Ghost Hub Logo](./ghosthub.png)

**Ghost Hub** é uma plataforma web para automação de missões do Discord, visualização de perfis, Orbs, badges e ferramentas exclusivas.

## Funcionalidades

- **Auto Quest Discord** — Complete missões do Discord automaticamente
- **Perfil & Badges** — Visualize informações detalhadas de perfil do Discord
- **Orbs** — Acompanhe e gerencie seus Orbs
- **Painel Web** — Interface moderna e responsiva para gerenciamento

## Estrutura do Projeto

| Arquivo | Descrição |
|---------|-----------|
| `script.js` | Backend principal (servidor Express + Discord selfbot) |
| `index.html` | Página inicial do site |
| `login.html` | Tela de login |
| `dashboard.html` | Painel do usuário |
| `quest.js` | Lógica de automação de missões |
| `discord-workers.js` | Sistema de workers multi-thread para Discord |
| `discord-worker-thread.js` | Thread worker para requisições Discord |
| `teste-api.js` | Testes de integração com API |
| `package.json` | Dependências do projeto |
| `ghosthub.png` | Logo oficial do Ghost Hub |

## Tecnologias

- **Node.js** + **Express**
- **Discord.js Selfbot v13**
- **HTML5 / CSS3 / JavaScript**
- **JWT** para autenticação segura
- **Sistema de rate limit** multi-camada

## Segurança

- Tokens Discord nunca são expostos ao frontend
- Sessões JWT com expiração de 1 hora
- Rate limiting por IP, sessão e token Discord
- Circuit breaker para proteção contra falhas

## Licença

Projeto privado — Ghost Hub.
