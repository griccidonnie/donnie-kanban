# 📋 Donnie Kanban

Un tablero Kanban moderno y minimalista diseñado para integrarse perfectamente con OpenClaw.

## ✨ Características

- **🎯 Workspaces & Proyectos** - Organización jerárquica completa
- **⚡ Tiempo Real** - WebSockets para colaboración instantánea
- **📎 Referencias & Archivos** - Enlaces y documentos adjuntos por proyecto
- **💾 SQLite** - Base de datos local, sin dependencias externas
- **🎨 UI Moderna** - Drag & drop, dark mode, responsive
- **🚀 Zero Config** - Funciona out-of-the-box

## 🚀 Instalación Rápida

```bash
# Clonar repositorio
git clone https://github.com/griccidonnie/donnie-kanban.git
cd donnie-kanban

# Instalar dependencias
npm install

# Iniciar servidor
npm start

# Abrir en navegador: http://localhost:8080
```

## 🔧 Instalación como Servicio (Linux)

Para ejecutar como servicio systemd permanente:

```bash
# Ejecutar script de instalación
chmod +x install.sh
./install.sh

# El servicio se iniciará automáticamente
# Acceder en: http://localhost:8080
```

## 📱 Uso

### Workspaces
- Crea workspaces para diferentes áreas (Personal, Trabajo, Proyectos)
- Arrastra proyectos entre workspaces

### Proyectos
- Cada proyecto tiene estado: `Idea`, `En Progreso`, `Completado`
- Colores personalizables para identificación visual
- Notas ilimitadas por proyecto

### Referencias & Archivos
- Añade enlaces útiles (GitHub repos, docs, etc.)
- Sube archivos directamente al proyecto
- Organiza recursos por proyecto

### Tiempo Real
- Múltiples usuarios pueden editar simultáneamente
- Cambios se sincronizan automáticamente
- Sin conflictos de concurrencia

## 🛠️ Stack Técnico

- **Backend:** Node.js + Express + WebSockets
- **Database:** SQLite3 con WAL mode
- **Frontend:** Vanilla HTML5 + CSS3 + JavaScript
- **Real-time:** WebSocket Server nativo
- **File Storage:** Sistema de archivos local

## 🔄 Integración OpenClaw

Este tablero fue diseñado específicamente para workflows de OpenClaw:

- **Puerto 8080** por defecto (configurable)
- **Auto-boot** con systemd service
- **Logging** compatible con OpenClaw gateway
- **Zero external dependencies** (solo SQLite local)

## 📋 API Endpoints

- `GET /api/workspaces` - Lista workspaces
- `POST /api/workspaces` - Crear workspace
- `GET /api/projects` - Lista proyectos
- `POST /api/projects` - Crear proyecto
- `PUT /api/projects/:id` - Actualizar proyecto
- `DELETE /api/projects/:id` - Eliminar proyecto
- `POST /api/projects/:id/files` - Subir archivo
- WebSocket en `/` para tiempo real

## 🎨 Capturas

### Vista Principal
![Tablero Principal](screenshot-main.png)

### Gestión de Proyectos
![Proyectos](screenshot-projects.png)

## 🔧 Configuración Avanzada

### Variables de Entorno
```bash
# Puerto del servidor (default: 8080)
export PORT=3000

# Ubicación base de datos (default: ./kanban.db)
export DB_PATH=/path/to/database.db

# Directorio uploads (default: ./uploads)
export UPLOADS_DIR=/path/to/uploads
```

### Personalización CSS
Edita `public/index.html` para modificar:
- Colores del tema
- Tipografía
- Espaciado y layout

## 🚀 Despliegue

### Railway
```bash
# Push a Railway (requiere railway CLI)
railway link [tu-proyecto]
railway up
```

### Docker (próximamente)
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

## 🤝 Contribuciones

Las contribuciones son bienvenidas! Por favor:

1. Fork el repositorio
2. Crea feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit cambios (`git commit -m 'Add AmazingFeature'`)
4. Push branch (`git push origin feature/AmazingFeature`)
5. Abre Pull Request

## 📝 Changelog

### v1.0.0 - Inicial
- ✅ Sistema de Workspaces y Proyectos
- ✅ Drag & Drop completo
- ✅ WebSockets tiempo real
- ✅ Sistema de archivos y referencias
- ✅ SQLite con WAL mode
- ✅ UI responsiva completa

## 📄 Licencia

MIT License - ver [LICENSE](LICENSE) para detalles.

## 👨‍💻 Autor

**Donnie Ricci** - [@griccidonnie](https://github.com/griccidonnie)

---

⚡ **Hecho para OpenClaw** - El tablero que necesitas para organizarte sin complicaciones.