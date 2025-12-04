#Command to start and Build
 sudo /usr/local/bin/docker-compose up --build -d


#Command to Rebuild without cache
docker-compose build --no-cache

#Check logs:
docker-compose logs -f sonar-servicenow-gateway
sudo docker logs gateway-service

#Stop service
sudo /usr/local/bin/docker-compose down

sudo docker logs -f sonarqube_servicenow_gateway-nginx-1


sudo docker inspect sonarqube_servicenow_gateway-gateway-1 | jq '.[0].State.Health'

sudo docker exec -it sonarqube_servicenow_gateway-gateway-1 curl http://localhost:3000/health

sudo docker inspect sonarqube_servicenow_gateway-gateway-1 | grep Health

sudo docker logs sonarqube_servicenow_gateway-gateway-1

sudo docker exec -it sonarqube_servicenow_gateway-gateway-1 env | grep -E 'SERVICENOW|IDP|PORT|SONARQUBE|RETRY'


#Verify Gateway Health
curl -k https://localhost/health
curl http://localhost:3000/health

#Verify Gateway Health behind NGINX HTTPS:
curl -k https://10.100.6.201/health

#Test Quality Gate OK Case

curl -X POST http://localhost:3000/sonarqube-webhook \
  -H "Content-Type: application/json" \
  -d '{"project":{"key":"project1","name":"Project One"},"qualityGate":{"status":"OK","conditions":[]}}'


#Login to containter and runn command
docker exec -it sonarqube-servicenow-gateway sh
curl -sSf http://localhost:3000/health



curl -X POST "https://atgedev.service-now.com/oauth_token.do" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=client_credentials&client_id=9e959bd87d914189bfef7fd906e96f35&client_secret=K(kSUSa!I[dmkIeEss6^!Romm@^(gN.!"


#Quick CHECK
Instance (atgedev.service-now.com) is reachable and correct.
The OAuth profile in ServiceNow is configured for Client Credentials grant.
Client ID/secret match the profile.
If behind a corporate proxy, set HTTPS_PROXY environment variable or curl --proxy https://proxy-host:port.