#!/bin/bash

# SiteLedger Reset Script
# Use this to completely wipe Docker and project files from your EC2 instance.

echo "🚮 Starting SiteLedger System Reset..."

# 1. Stop and remove Docker services
if command -v docker &> /dev/null; then
    echo "🛑 Stopping Docker containers..."
    # Attempt to down compose if directory exists
    if [ -d "~/real-estate" ]; then
        cd ~/real-estate && docker compose down --volumes --remove-orphans || true
    fi
fi

# 2. Uninstall Docker
echo "📦 Uninstalling Docker packages..."
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras || true
sudo apt-get autoremove -y --purge

# 3. Clean up system files
echo "🧹 Cleaning up system files..."
sudo rm -rf /var/lib/docker /var/lib/containerd /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.gpg
sudo deluser $USER docker || true

# 4. Remove project folder
cd ~ && rm -rf ~/real-estate

echo "✨ System reset complete! Your EC2 is now fresh."
