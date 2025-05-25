# Freekassa Payment Callback Handler

This is a Vercel serverless function that handles payment callbacks from Freekassa payment system.

## Features

- Handles Freekassa payment notifications
- Verifies payment signatures
- Updates order status in database
- Sends Telegram notifications to users
- Supports merchant verification (GET requests)

## Environment Variables

The following environment variables need to be set in Vercel:

- `DATABASE_URL`: PostgreSQL connection string
- `BOT_TOKEN`: Telegram bot token
- `FREEKASSA_SECRET_2`: Freekassa second secret key

## API Endpoints

- `GET /api/callback`: Merchant verification endpoint
- `POST /api/callback`: Payment notification endpoint

## Response Format

- Success: `YES`
- Error: Error message with appropriate HTTP status code

## Security

- CORS headers configured for Freekassa servers
- MD5 signature verification
- SSL/TLS encryption 