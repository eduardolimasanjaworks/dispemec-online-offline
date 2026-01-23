@echo off
echo ========================================
echo  Upload para GitHub
echo ========================================
echo.
echo Este script vai fazer o upload do codigo para:
echo https://github.com/implementacao-techfala/online_ou_offline.git
echo.
echo Certifique-se de estar autenticado no GitHub!
echo.
pause

cd /d "%~dp0"

echo.
echo [1/4] Verificando status do git...
git status

echo.
echo [2/4] Adicionando arquivos...
git add .

echo.
echo [3/4] Fazendo commit...
git commit -m "Update: Sistema completo de monitoramento" 2>nul
if errorlevel 1 (
    echo Nenhuma alteracao para commitar.
)

echo.
echo [4/4] Fazendo push para GitHub...
echo.
echo OPCAO 1: Se voce tem GitHub CLI instalado:
echo   gh auth login
echo   git push -u origin main
echo.
echo OPCAO 2: Com token de acesso:
echo   Seu token: ghp_************************************
echo   Execute: git push -u origin main
echo   (O Git vai pedir usuario e senha - use o token como senha)
echo.
echo OPCAO 3: Criar novo token:
echo   1. Va em: https://github.com/settings/tokens
echo   2. Clique em "Generate new token (classic)"
echo   3. Marque "repo" (acesso completo)
echo   4. Copie o token e use como senha
echo.
pause

echo.
echo Tentando push automatico...
git push -u origin main

if errorlevel 1 (
    echo.
    echo ========================================
    echo  ERRO NO PUSH
    echo ========================================
    echo.
    echo Possíveis causas:
    echo 1. Token expirado ou sem permissoes
    echo 2. Nao autenticado no Git
    echo 3. Repositorio nao existe ou sem acesso
    echo.
    echo Solucoes:
    echo.
    echo A) Usar GitHub Desktop:
    echo    1. Baixe: https://desktop.github.com/
    echo    2. Abra o repositorio nesta pasta
    echo    3. Faca push pela interface
    echo.
    echo B) Reautenticar:
    echo    git config --global user.name "SEU_NOME"
    echo    git config --global user.email "SEU_EMAIL"
    echo    gh auth login
    echo.
    echo C) Verificar repositorio:
    echo    Acesse: https://github.com/implementacao-techfala/online_ou_offline
    echo    Confirme que o repositorio existe e voce tem acesso
    echo.
) else (
    echo.
    echo ========================================
    echo  SUCESSO!
    echo ========================================
    echo.
    echo Codigo enviado para:
    echo https://github.com/implementacao-techfala/online_ou_offline
    echo.
)

pause
