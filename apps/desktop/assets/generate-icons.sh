#!/bin/bash
# Generate app icons from SVG (requires sips on macOS)
# For tray icon, create a simple 18x18 PNG

# Create a placeholder tray icon (1x1 transparent PNG as fallback)
# In production, replace with proper icon generated from icon.svg
printf '\x89PNG\r\n\x1a\n' > tray-icon.png
echo "Placeholder tray-icon.png created. Replace with proper 18x18 PNG."
echo "Use: npx @nicolo-ribaudo/svg2png icon.svg --output icon.png --width 512"
echo "Then: sips -s format icns icon.png --out icon.icns"
