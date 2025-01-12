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

# SSH into the instance and set up the environment
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

# Copy .env file directly to project directory
echo "Copying .env file to project directory..."
scp -i $PEM_PATH .env ubuntu@$AWS_IP:~/eliza/.env

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

    # Fix .env file format if needed
    echo "Verifying .env file format..."
    # Remove any Windows line endings and ensure proper format
    sed -i 's/\r$//' .env
    # Ensure each line has proper KEY=VALUE format
    sed -i '/^[^#]/s/ = /=/' .env

    # Set proper permissions
    chmod 600 .env

    echo "Verifying environment variables..."
    # Check critical environment variables
    source .env

    # Check Twitter credentials
    if [ -z "$TWITTER_USERNAME" ] || [ -z "$TWITTER_PASSWORD" ] || [ -z "$TWITTER_EMAIL" ]; then
        echo "Error: Twitter credentials are not properly set in .env"
        echo "TWITTER_USERNAME: ${TWITTER_USERNAME:-not set}"
        echo "TWITTER_PASSWORD: ${TWITTER_PASSWORD:-not set}"
        echo "TWITTER_EMAIL: ${TWITTER_EMAIL:-not set}"
        exit 1
    fi

    # Check OpenAI API key
    if [ -z "$OPENAI_API_KEY" ]; then
        echo "Error: OPENAI_API_KEY is not set in .env"
        exit 1
    fi

    echo "Environment variables verified successfully."

    # Stop existing containers
    echo "Stopping existing containers..."
    sudo docker-compose down

    # Pull latest images and rebuild
    echo "Building and starting containers..."
    sudo docker-compose pull
    sudo docker-compose up -d --build

    # Wait for container to be ready
    echo "Waiting for container to be ready..."
    sleep 5

    # Check container status
    echo "Container Status:"
    sudo docker-compose ps

    # Verify environment variables in container
    echo "Verifying environment variables in container..."
    CONTAINER_ID=$(sudo docker-compose ps -q tee)
    if [ ! -z "$CONTAINER_ID" ]; then
        echo "Checking environment variables in container:"
        echo "TWITTER_USERNAME:"
        sudo docker exec $CONTAINER_ID sh -c 'echo $TWITTER_USERNAME'
        echo "TWITTER_EMAIL:"
        sudo docker exec $CONTAINER_ID sh -c 'echo $TWITTER_EMAIL'
        echo "OPENAI_API_KEY (first 10 chars):"
        sudo docker exec $CONTAINER_ID sh -c 'echo ${OPENAI_API_KEY:0:10}...'
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