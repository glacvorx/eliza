#!/bin/bash

# AWS instance details
AWS_IP="13.212.199.180"
PEM_PATH="./agentyp-main.pem"

# Ensure correct permissions for .pem file
chmod 400 $PEM_PATH

# First, check if local .env exists
if [ ! -f .env ]; then
    echo "Error: Local .env file not found!"
    exit 1
fi

# Copy .env file and character file to the server
echo "Copying files to server..."
scp -i $PEM_PATH .env ubuntu@$AWS_IP:~/eliza/.env

# SSH into the instance and set up the environment
ssh -i $PEM_PATH ubuntu@$AWS_IP << 'EOF'
    echo "Checking Node.js environment..."

    # Load nvm if it exists
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

    # Check if nvm is installed
    if ! command -v nvm &> /dev/null; then
        echo "Installing nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    else
        echo "nvm is already installed"
    fi

    # Check Node.js version
    if ! command -v node &> /dev/null || [[ $(node -v) != v23* ]]; then
        echo "Installing Node.js 23..."
        nvm install 23
        nvm use 23
    else
        echo "Node.js 23 is already installed"
    fi

    # Verify Node.js version
    echo "Current Node.js version:"
    node --version

    # Check pnpm version and install/update if needed
    install_or_update_pnpm() {
        echo "Installing/updating pnpm..."
        npm install -g pnpm@latest
    }

    if ! command -v pnpm &> /dev/null; then
        install_or_update_pnpm
    else
        PNPM_VERSION=$(pnpm --version)
        MAJOR_VERSION=$(echo $PNPM_VERSION | cut -d. -f1)
        if [ "$MAJOR_VERSION" -lt 9 ]; then
            echo "Updating pnpm (current version: $PNPM_VERSION)..."
            install_or_update_pnpm
        else
            echo "pnpm version $PNPM_VERSION is already installed"
        fi
    fi

    # Verify pnpm version
    echo "Current pnpm version:"
    pnpm --version

    # Update or clone the repository
    if [ -d ~/eliza ]; then
        echo "Updating existing repository..."
        cd ~/eliza
        git pull
    else
        echo "Cloning repository..."
        git clone https://github.com/longwind48/eliza.git ~/eliza
        cd ~/eliza
    fi

    # Install dependencies only if node_modules doesn't exist or package.json has changed
    if [ ! -d "node_modules" ] || [ package.json -nt node_modules ]; then
        echo "Installing build tools..."
        sudo apt-get update
        sudo apt-get install -y python3 make g++ build-essential

        echo "Installing dependencies..."
        rm -rf node_modules
        rm -rf pnpm-lock.yaml
        pnpm install --no-frozen-lockfile

        echo "Building project..."
        pnpm build
    else
        echo "Dependencies are up to date"
    fi

    # Kill any existing node processes and free up ports
    echo "Cleaning up existing processes and ports..."
    pkill -9 -f "node.*eliza" || true
    pkill -9 -f "pnpm" || true
    sudo lsof -ti:3000 | xargs -r sudo kill -9
    sudo lsof -ti:3001 | xargs -r sudo kill -9
    sudo lsof -ti:3002 | xargs -r sudo kill -9
    sleep 2

    # Set up environment variables
    echo "Setting up environment variables..."
    set -a
    source .env
    set +a

    # Start the application in the background with proper logging
    echo "Starting the application..."
    nohup pnpm build && pnpm start --character="characters/Agent_YP.character.json" > output.log 2>&1 &

    # Wait a moment and then show the logs
    sleep 5
    echo "Recent logs:"
    tail -n 50 output.log

    echo "To view logs in real-time, use:"
    echo "tail -f ~/eliza/output.log"
EOF

echo "Deployment completed!"
echo "To view logs:"
echo "ssh -i $PEM_PATH ubuntu@$AWS_IP 'tail -f ~/eliza/output.log'"