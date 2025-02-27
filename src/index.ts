import * as Serverless from "serverless";

export default class SwaggerApiPlugin {
  hooks: { [key: string]: any };
  name: string;

  constructor(serverless: Serverless, options: any) {
    this.name = "serverless-swagger-api";

    this.hooks = {
      "before:package:finalize": () => updateApiDefinitions(serverless)
    };
  }
}

module.exports = SwaggerApiPlugin;

function updateApiDefinitions(serverless: Serverless) {
  const apis = serverless.service.custom.swaggerApi;
  for (const key in apis) {
    const api = apis[key];
    createRestApi(serverless, key, api);
  }
}

function createRestApi(serverless: Serverless, key: string, restApi: any) {
  const resources =
    serverless.service.provider.compiledCloudFormationTemplate.Resources;
  const stage = restApi.Stage || serverless.service.provider.stage;
  const service = serverless.service.getServiceName();
  const functionNames = [];
  const lambdaPermissions = {};

  for (const path in restApi.Body.paths) {
    const methods = Object.keys(restApi.Body.paths[path]).reduce((acc, p) => {
      if(["get", "post", "put", "patch", "delete", "head", "options"].includes(p)){
          const value = restApi.Body.paths[path][p]
          return {...acc, [p]: value}
      } else {
          return acc
      }
    }, {});

    for (const method in methods) {
      const methodProps = methods[method];
      const functionName = methodProps["x-lambda-name"];
      functionNames.push(functionName);

      methodProps["x-amazon-apigateway-integration"] = {
        uri: {
          "Fn::Sub": `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${functionName}.Arn}/invocations`
        },
        passthroughBehavior: "when_no_match",
        httpMethod: "POST",
        type: "aws_proxy",
        responses: {}
      };

      if (!lambdaPermissions[functionName]) {
        lambdaPermissions[functionName] = [];
      }

      lambdaPermissions[functionName].push(`${method.toUpperCase()}${path}`);
    }
  }

  functionNames.forEach(functionName => {
    const paths = lambdaPermissions[functionName];

    paths.forEach(path => {
      resources[
        `${key}${functionName}${path.replace(/[^A-Za-z0-9]/g, "")}Permission`
      ] = {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: { "Fn::Sub": `\${${functionName}.Arn}` },
          Action: "lambda:InvokeFunction",
          Principal: { "Fn::Sub": "apigateway.${AWS::URLSuffix}" },
          SourceArn: {
            "Fn::Sub": `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${key}}/*/${path}`
          }
        }
      };
    });
  });

  // Create api
  resources[key] = {
    Type: "AWS::ApiGateway::RestApi",
    Properties: {
      Name: restApi.Name,
      Body: restApi.Body
    }
  };

  resources[`${key}Deployment`] = {
    Type: "AWS::ApiGateway::Deployment",
    DependsOn: [key],
    Properties: {
      RestApiId: { "Fn::Sub": `\${${key}}` },
      StageName: stage
    }
  };

  resources[`${key}ServiceRole`] = {
    Type: "AWS::IAM::Role",
    Properties: {
      RoleName: `${stage}-${service}-${key}-APIRole`,
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "apigateway.amazonaws.com"
            },
            Action: "sts:AssumeRole"
          }
        ]
      },
      Policies: [
        {
          PolicyName: `${stage}-${service}-${key}-APIPolicy`,
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: functionNames.map(functionName => ({
              Action: "lambda:InvokeFunction",
              Resource: { "Fn::Sub": `\${${functionName}.Arn}` },
              Effect: "Allow"
            }))
          }
        }
      ]
    }
  };
}
