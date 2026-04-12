#!/bin/bash

# 📋 Donnie Kanban - Instalador Automático
# Instala como servicio systemd en Linux

set -e

echo "🚀 Instalando Donnie Kanban como servicio systemd..."

# Verificar que estamos en el directorio correcto
if [ ! -f "server.js" ] || [ ! -f "package.json" ]; then
    echo "❌ Error: Ejecuta este script desde el directorio donnie-kanban"
    exit 1
fi

# Obtener directorio actual
KANBAN_DIR=$(pwd)
USER=$(whoami)

# Instalar dependencias si no existen
if [ ! -d "node_modules" ]; then
    echo "📦 Instalando dependencias..."
    npm install
fi

# Crear archivo de servicio systemd
SERVICE_FILE="kanban.service"
cat > $SERVICE_FILE << EOF
[Unit]
Description=Donnie Kanban Board
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$KANBAN_DIR
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=8080

[Install]
WantedBy=default.target
EOF

# Copiar servicio a directorio systemd user
mkdir -p ~/.config/systemd/user
cp $SERVICE_FILE ~/.config/systemd/user/

# Recargar systemd y habilitar servicio
systemctl --user daemon-reload
systemctl --user enable kanban.service
systemctl --user start kanban.service

# Verificar estado
sleep 2
if systemctl --user is-active --quiet kanban.service; then
    echo "✅ Donnie Kanban instalado correctamente!"
    echo "🌐 Accede en: http://localhost:8080"
    echo "📊 Estado del servicio:"
    systemctl --user status kanban.service --no-pager -l
else
    echo "❌ Error al iniciar el servicio"
    systemctl --user status kanban.service --no-pager -l
    exit 1
fi

echo ""
echo "🔧 Comandos útiles:"
echo "  systemctl --user start kanban.service    # Iniciar"
echo "  systemctl --user stop kanban.service     # Detener"
echo "  systemctl --user restart kanban.service  # Reiniciar"
echo "  systemctl --user status kanban.service   # Estado"
echo "  systemctl --user disable kanban.service  # Deshabilitar"

echo ""
echo "📋 Instalación completada. ¡Disfruta tu tablero Kanban!"