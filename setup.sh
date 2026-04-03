#!/bin/bash

# Configuration
PROJECT_DIR="$(eval echo ~ubuntu)/real-estate"
DOMAIN="api.sitesledger.app"
EMAIL="aaryapathak12@gmail.com"
CERT_PATH="$PROJECT_DIR/certbot/conf/live/$DOMAIN/fullchain.pem"

echo "🚀 Initializing SiteLedger Setup..."

# 1. Create project root directory
if [ ! -d "$PROJECT_DIR" ]; then
    echo "📂 Creating project root directory: $PROJECT_DIR"
    mkdir -p $PROJECT_DIR
else
    echo "✅ Project root directory already exists: $PROJECT_DIR"
fi

# 2. Install Docker (Ubuntu only)
if ! command -v docker &> /dev/null; then
    echo "🐳 Docker not found. Installing Docker for Ubuntu..."
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    echo "✅ Docker installation complete!"
else
    echo "✅ Docker is already installed."
fi

# 3. Setup User Permissions
if ! groups $USER | grep &>/dev/null "\bdocker\b"; then
    echo "👤 Adding $USER to docker group..."
    sudo usermod -aG docker $USER
    echo "⚠️  IMPORTANT: Please log out and back into your EC2 instance for permissions to take effect!"
else
    echo "✅ User $USER is already in the docker group."
fi

# 4. Create Certbot directories
echo "🔐 Creating Certbot directories..."
mkdir -p "$PROJECT_DIR/certbot/conf" "$PROJECT_DIR/certbot/www"

# 5. Autonomous SSL Bootstrapping
# Using sudo to check existence because certbot directories are root-only (0700)
if ! sudo [ -f "$CERT_PATH" ]; then
    echo "📜 Certificate NOT found or inaccessible. Requesting initial certificate for $DOMAIN..."
    
    # 1. Forcefully kill everything on Port 80 and stop containers
    echo "🛑 Cleaning up port 80 and existing containers..."
    sudo fuser -k 80/tcp || true
    cd "$PROJECT_DIR" && sudo docker compose down --remove-orphans || true
    
    # Wait for port to be released
    sleep 2
    
    # 2. Request certificate via Standalone mode
    echo "⚙️  Starting Certbot standalone container..."
    sudo docker run --rm --name certbot-init \
        -p 80:80 \
        -v "$PROJECT_DIR/certbot/conf:/etc/letsencrypt" \
        -v "$PROJECT_DIR/certbot/www:/var/www/certbot" \
        certbot/certbot certonly --standalone \
        --email "$EMAIL" --agree-tos --no-eff-email \
        -d "$DOMAIN" --non-interactive
        
    if sudo [ -f "$CERT_PATH" ]; then
        echo "✅ Initial certificate successfully acquired!"
    else
        echo "❌ FATAL: Certificate request failed."
        echo "   Possible reasons: DNS not propagated, Cloudflare Proxy active, or Security Group port 80 blocked."
    fi
else
    echo "✅ SSL certificate already exists and is accessible."
fi

# 6. Handle .env synchronization
if [ ! -f "$PROJECT_DIR/.env" ]; then
    if [ ! -z "$ENV_FILE_CONTENT" ] && [ "$ENV_FILE_CONTENT" != " " ]; then
        echo "📄 Generating .env from GitHub Secrets..."
        echo "$ENV_FILE_CONTENT" > "$PROJECT_DIR/.env"
        # Ensure correct permissions
        chmod 600 "$PROJECT_DIR/.env"
        echo "✅ .env file created from CI/CD secrets."
    else
        echo "❌ ERROR: .env file missing and ENV_FILE_CONTENT secret is EMPTY in GitHub!"
    fi
else
    echo "✅ .env file already exists."
fi

echo "✅ Full setup sequence complete!"

