# Cloud Run Backend for Teller

This service keeps Teller credentials server-side and exposes minimal endpoints for your app.

## Endpoints

- `GET /healthz`
- `POST /teller/enroll`
  - Body: `{ "userId": "default", "accessToken": "<teller_access_token>" }`
  - Header: `x-api-key: <API_KEY>`
- `GET /teller/transactions?userId=default&start_date=2026-01-01`
  - Header: `x-api-key: <API_KEY>`

## Prerequisites

- Google Cloud project with billing enabled
- `gcloud` CLI authenticated
- Teller certificate PEM and private key PEM files

## 1) Enable APIs

```sh
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com firestore.googleapis.com
```

## 2) Create Firestore (Native mode)

```sh
gcloud firestore databases create --location=us-central
```

If a Firestore database already exists, skip.

## 3) Create secrets for Teller mTLS

```sh
gcloud secrets create teller-cert-pem --replication-policy=automatic
gcloud secrets create teller-key-pem --replication-policy=automatic

gcloud secrets versions add teller-cert-pem --data-file=./cert.pem
gcloud secrets versions add teller-key-pem --data-file=./key.pem
```

## 4) Deploy to Cloud Run

Set variables for your environment first:

```sh
export PROJECT_ID="your-project-id"
export REGION="me-central1"
export SERVICE_NAME="familybudget-teller"
export API_KEY="replace-with-long-random-string"
```

Deploy from this directory:

```sh
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "API_KEY=$API_KEY,GCP_PROJECT=$PROJECT_ID,TELLER_CERT_SECRET_NAME=teller-cert-pem,TELLER_KEY_SECRET_NAME=teller-key-pem"
```

## 5) Grant Secret Manager access to Cloud Run service account

Get the runtime service account used by Cloud Run (default shown):

```sh
export SA_EMAIL="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
```

Grant read access:

```sh
gcloud secrets add-iam-policy-binding teller-cert-pem \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding teller-key-pem \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

## 6) Smoke test

```sh
export BASE_URL="https://<your-cloud-run-url>"

curl -s "$BASE_URL/healthz"

curl -s -X POST "$BASE_URL/teller/enroll" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"userId":"default","accessToken":"<TELLER_ACCESS_TOKEN>"}'

curl -s "$BASE_URL/teller/transactions?userId=default&start_date=2026-01-01" \
  -H "x-api-key: $API_KEY"
```

## iOS integration note

The iOS app should call this backend, not Teller directly.

- Save `API_KEY` in app config for now (personal app); move to signed-auth later if needed.
- Send Teller access token from your connect flow to `/teller/enroll` once.
- Periodically fetch `/teller/transactions` and import into SwiftData.
