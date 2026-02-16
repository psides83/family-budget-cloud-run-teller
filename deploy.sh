#!/bin/zsh
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:=us-central1}"
: "${SERVICE_NAME:=familybudget-teller}"
: "${API_KEY:?Set API_KEY}"
: "${TELLER_CERT_SECRET_NAME:=teller-cert-pem}"
: "${TELLER_KEY_SECRET_NAME:=teller-key-pem}"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "API_KEY=$API_KEY,TELLER_CERT_SECRET_NAME=$TELLER_CERT_SECRET_NAME,TELLER_KEY_SECRET_NAME=$TELLER_KEY_SECRET_NAME"
