#!/bin/bash

# AWS instance details
AWS_IP="13.212.199.180"
PEM_PATH="./agentyp-main.pem"

# Ensure correct permissions for .pem file
chmod 400 $PEM_PATH

# SSH into the instance and set up the environment (only if needed)
ssh -i $PEM_PATH ubuntu@$AWS_IP << 'EOF'
    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        echo "Installing Docker..."
        sudo apt-get update
        sudo apt-get install -y docker.io
        sudo systemctl start docker
        sudo systemctl enable docker
        sudo usermod -aG docker $USER
    fi

    # Check if Docker Compose is installed
    if ! command -v docker-compose &> /dev/null; then
        echo "Installing Docker Compose..."
        sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/bin/docker-compose
    fi

    # Check if Git is installed
    if ! command -v git &> /dev/null; then
        echo "Installing Git..."
        sudo apt-get install -y git
    fi

    # Update or clone the repository
    if [ -d ~/eliza ]; then
        echo "Updating existing repository..."
        cd ~/eliza
        git pull
    else
        echo "Cloning repository..."
        git clone https://github.com/longwind48/eliza.git ~/eliza
    fi
EOF

# Copy .env file if it exists locally
if [ -f .env ]; then
    echo "Copying .env file..."
    scp -i $PEM_PATH .env ubuntu@$AWS_IP:~/eliza/
else
    echo "No .env file found locally. Creating from .env.example..."
    scp -i $PEM_PATH .env.example ubuntu@$AWS_IP:~/eliza/.env
fi

# SSH into the instance and start/update the application
ssh -i $PEM_PATH ubuntu@$AWS_IP << 'EOF'
    cd ~/eliza

    # Verify .env file exists and has content
    if [ ! -f .env ]; then
        echo "Error: .env file not found!"
        exit 1
    fi

    if [ ! -s .env ]; then
        echo "Error: .env file is empty!"
        exit 1
    fi

    echo "Verifying environment variables..."
    # Check a few critical environment variables
    source .env
    if [ -z "$OPENAI_API_KEY" ]; then
        echo "Warning: OPENAI_API_KEY is not set in .env"
    fi
    if [ -z "$TWITTER_USERNAME" ]; then
        echo "Warning: TWITTER_USERNAME is not set in .env"
    fi

    # Stop existing containers
    echo "Stopping existing containers..."
    sudo docker-compose down

    # Pull latest images and rebuild
    echo "Building and starting containers..."
    sudo docker-compose pull
    sudo docker-compose --env-file .env up -d --build

    # Wait for container to be ready
    echo "Waiting for container to be ready..."
    sleep 5

    # Check container status
    echo "Container Status:"
    sudo docker-compose ps

    # Show build and startup events
    echo "Recent Events:"
    sudo docker-compose events --json | tail -n 5

    # Verify environment variables in container
    echo "Verifying environment variables in container..."
    CONTAINER_ID=$(sudo docker-compose ps -q tee)
    if [ ! -z "$CONTAINER_ID" ]; then
        echo "Checking OPENAI_API_KEY..."
        sudo docker exec $CONTAINER_ID sh -c 'echo $OPENAI_API_KEY'
        echo "Checking TWITTER_USERNAME..."
        sudo docker exec $CONTAINER_ID sh -c 'echo $TWITTER_USERNAME'
    else
        echo "Warning: Container not found!"
    fi

    # Show recent logs
    echo "Recent Logs:"
    sudo docker-compose logs --tail=50

    # Clean up old images
    echo "Cleaning up old images..."
    sudo docker image prune -f

    echo "To view ongoing logs, use:"
    echo "ssh -i $PEM_PATH ubuntu@$AWS_IP 'cd ~/eliza && sudo docker-compose logs -f'"
EOF

echo "Deployment completed!"
echo "To monitor logs:"
echo "ssh -i $PEM_PATH ubuntu@$AWS_IP 'cd ~/eliza && sudo docker-compose logs -f'"