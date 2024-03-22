import YAML from "json-to-pretty-yaml";
import fs from "fs";
import path from "path";
import util from "util";
import extract from "extract-comments";
import HTTPStatusCode from "http-status-code";
import { camelCase, isEmpty, isUndefined, snakeCase, startCase } from "lodash";
import { existsSync } from "fs";
import { scalarCustomCss } from "./scalarCustomCss";
import { serializeV6Middleware, serializeV6Handler } from "./adonishelpers";
import Parser from "./parsers";

import type { options, AdonisRoutes, v6Handler } from "./types";

import { mergeParams } from "./helpers";

/**
 * Helpers
 */

function formatOperationId(inputString: string): string {
  // Remove non-alphanumeric characters and split the string into words
  const cleanedWords = inputString.replace(/[^a-zA-Z0-9]/g, " ").split(" ");

  // Pascal casing words
  const pascalCasedWords = cleanedWords.map((word) =>
    startCase(camelCase(word))
  );

  // Generate operationId by joining every parts
  const operationId = pascalCasedWords.join();

  // CamelCase the operationId
  return camelCase(operationId);
}

export class AutoSwagger {
  private options: options;
  private schemas = {};
  private parser;

  ui(url: string, options?: options) {
    const persistAuthString = options?.persistAuthorization
      ? "persistAuthorization: true,"
      : "";
    return `<!DOCTYPE html>
		<html lang="en">
		<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="X-UA-Compatible" content="ie=edge">
				<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.3/swagger-ui-standalone-preset.js"></script>
				<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.3/swagger-ui-bundle.js"></script>
				<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.1.3/swagger-ui.css" />
				<title>Documentation</title>
		</head>
		<body>
				<div id="swagger-ui"></div>
				<script>
						window.onload = function() {
							SwaggerUIBundle({
								url: "${url}",
								dom_id: '#swagger-ui',
								presets: [
									SwaggerUIBundle.presets.apis,
									SwaggerUIStandalonePreset
								],
								layout: "BaseLayout",
                ${persistAuthString}
							})
						}
				</script>
		</body>
		</html>`;
  }

  rapidoc(url: string, style = "view") {
    return (
      `
    <!doctype html> <!-- Important: must specify -->
    <html>
      <head>
        <meta charset="utf-8"> <!-- Important: rapi-doc uses utf8 characters -->
        <script type="module" src="https://unpkg.com/rapidoc/dist/rapidoc-min.js"></script>
        <title>Documentation</title>
      </head>
      <body>
        <rapi-doc
          spec-url = "` +
      url +
      `"
      theme = "dark"
      bg-color = "#24283b"
      header-color = "#1a1b26"
      nav-hover-bg-color = "#1a1b26"
      nav-bg-color = "#24283b"
      text-color = "#c0caf5"
      nav-text-color = "#c0caf5"
      primary-color = "#9aa5ce"
      heading-text = "Documentation"
      sort-tags = "true"
      render-style = "` +
      style +
      `"
      default-schema-tab = "example"
      show-components = "true"
      allow-spec-url-load = "false"
      allow-spec-file-load = "false"
      sort-endpoints-by = "path"

        > </rapi-doc>
      </body>
    </html>
    `
    );
  }

  scalar(url: string) {
    return `
      <!doctype html>
      <html>
        <head>
          <title>API Reference</title>
          <meta charset="utf-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1" />
          <style>
          ${scalarCustomCss}
          </style>
        </head>
        <body>
          <script
            id="api-reference"
            data-url="${url}"
            data-proxy-url="https://api.scalar.com/request-proxy"></script>
          <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
        </body>
      </html>
    `;
  }

  jsonToYaml(json: any) {
    return YAML.stringify(json);
  }

  async json(routes: any, options: options) {
    this.parser = new Parser(options);
    if (process.env.NODE_ENV === "production") {
      return this.readFile(options.path, "json");
    }
    return await this.generate(routes, options);
  }

  async writeFile(routes: any, options: options) {
    this.parser = new Parser(options);
    const json = await this.generate(routes, options);
    const contents = this.jsonToYaml(json);
    const filePath = options.path + "swagger.yml";
    const filePathJson = options.path + "swagger.json";

    fs.writeFileSync(filePath, contents);
    fs.writeFileSync(filePathJson, JSON.stringify(json, null, 2));
  }

  private async readFile(rootPath, type = "yaml") {
    const filePath = rootPath + "swagger." + type;
    const data = fs.readFileSync(filePath, "utf-8");
    if (!data) {
      console.error("Error reading file");
      return;
    }
    return data;
  }

  async docs(routes: any, options: options) {
    this.parser = new Parser(options);
    if (process.env.NODE_ENV === "production") {
      return this.readFile(options.path);
    }
    return this.jsonToYaml(await this.generate(routes, options));
  }

  private async generate(adonisRoutes: AdonisRoutes, options: options) {
    this.options = {
      ...{
        snakeCase: true,
        preferredPutPatch: "PUT",
      },
      ...options,
    };
    const routes = adonisRoutes.root;
    this.options.path = this.options.path + "app";
    this.schemas = await this.getSchemas();

    const docs = {
      openapi: "3.0.0",
      info: {
        title: options.title,
        version: options.version,
      },

      components: {
        responses: {
          Forbidden: {
            description: "Access token is missing or invalid",
          },
          Accepted: {
            description: "The request was accepted",
          },
          Created: {
            description: "The resource has been created",
          },
          NotFound: {
            description: "The resource has been created",
          },
          NotAcceptable: {
            description: "The resource has been created",
          },
        },
        securitySchemes: {
          BearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
        schemas: this.schemas,
      },
      paths: {},
      tags: [],
    };
    let paths = {};

    let securities = {
      "auth": { BearerAuth: ["access"] },
      "auth:api": { BearerAuth: ["access"] },
    };

    let globalTags = [];
    for await (const route of routes) {
      let ignore = false;
      for (const i of options.ignore) {
        if (
          route.pattern.includes(i) ||
          (i.endsWith("*") && route.pattern.startsWith(i.slice(0, -1))) ||
          (i.startsWith("*") && route.pattern.endsWith(i.slice(1)))
        ) {
          ignore = true;
          break;
        }
      }
      if (ignore) continue;

      let security = [];
      const responseCodes = {
        GET: "200",
        POST: "201",
        DELETE: "202",
        PUT: "204",
      };

      if (!Array.isArray(route.middleware)) {
        route.middleware = serializeV6Middleware(route.middleware) as string[];
      }

      (route.middleware as string[]).forEach((m) => {
        if (typeof securities[m] !== "undefined") {
          security.push(securities[m]);
        }
      });

      let sourceFile = "";
      let action = "";
      let customAnnotations;
      let operationId = "";
      if (
        route.meta.resolvedHandler !== null &&
        route.meta.resolvedHandler !== undefined
      ) {
        if (
          typeof route.meta.resolvedHandler.namespace !== "undefined" &&
          route.meta.resolvedHandler.method !== "handle"
        ) {
          sourceFile = route.meta.resolvedHandler.namespace;

          action = route.meta.resolvedHandler.method;
          // If not defined by an annotation, use the combination of "controllerNameMethodName"
          if (action !== "" && isUndefined(operationId) && route.handler) {
            operationId = formatOperationId(route.handler as string);
          }

          if (sourceFile !== "" && action !== "") {
            customAnnotations = await this.parser.getCustomAnnotations(
              sourceFile,
              action
            );
          }
        }
      }

      let v6handler = <v6Handler>route.handler;
      if (
        v6handler.reference !== null &&
        v6handler.reference !== undefined &&
        v6handler.reference !== ""
      ) {
        if (!Array.isArray(v6handler.reference)) {
          const split = v6handler.reference.split(".");
          sourceFile = split[0];
          action = split[1];
          operationId = formatOperationId(v6handler.reference);
          sourceFile = options.path + "app/controllers/" + sourceFile;
          if (sourceFile !== "" && action !== "") {
            customAnnotations = await this.parser.getCustomAnnotations(
              sourceFile,
              action
            );
          }
        } else {
          v6handler = await serializeV6Handler(v6handler);
          action = v6handler.method;
          sourceFile = v6handler.moduleNameOrPath;
          sourceFile = sourceFile.replace("#", "");
          sourceFile = options.path + "app/" + sourceFile;
          if (sourceFile !== "" && action !== "") {
            customAnnotations = await this.parser.getCustomAnnotations(
              sourceFile,
              action
            );
          }
        }
      }

      let { tags, parameters, pattern } = this.parser.extractInfos(
        route.pattern
      );

      tags.forEach((tag) => {
        if (globalTags.filter((e) => e.name === tag).length > 0) return;
        if (tag === "") return;
        globalTags.push({
          name: tag,
          description: "Everything related to " + tag,
        });
      });

      route.methods.forEach((method) => {
        let responses = {};
        if (method === "HEAD") return;

        if (
          route.methods.includes("PUT") &&
          route.methods.includes("PATCH") &&
          method !== this.options.preferredPutPatch
        )
          return;

        let description = "";
        let summary = "";
        let operationId: string;

        if (security.length > 0) {
          responses["401"] = {
            description: HTTPStatusCode.getMessage(401),
          };
          responses["403"] = {
            description: HTTPStatusCode.getMessage(403),
          };
        }

        let requestBody = {
          content: {
            "application/json": {},
          },
        };

        let actionParams = {};

        if (action !== "" && typeof customAnnotations[action] !== "undefined") {
          description = customAnnotations[action].description;
          summary = customAnnotations[action].summary;
          operationId = customAnnotations[action].operationId;
          responses = { ...responses, ...customAnnotations[action].responses };
          requestBody = customAnnotations[action].requestBody;
          actionParams = customAnnotations[action].parameters;
        }
        parameters = mergeParams(parameters, actionParams);

        if (isEmpty(responses)) {
          responses[responseCodes[method]] = {
            description: HTTPStatusCode.getMessage(responseCodes[method]),
            content: {
              "application/json": {},
            },
          };
        } else {
          if (
            typeof responses[responseCodes[method]] !== "undefined" &&
            typeof responses[responseCodes[method]]["summary"] !== "undefined"
          ) {
            if (summary === "") {
              summary = responses[responseCodes[method]]["summary"];
            }
            delete responses[responseCodes[method]]["summary"];
          }
          if (
            typeof responses[responseCodes[method]] !== "undefined" &&
            typeof responses[responseCodes[method]]["description"] !==
              "undefined"
          ) {
            description = responses[responseCodes[method]]["description"];
          }
        }

        if (action !== "" && summary === "") {
          // Solve toLowerCase undefined exception
          // https://github.com/ad-on-is/adonis-autoswagger/issues/28
          tags[0] = tags[0] ?? "";

          switch (action) {
            case "index":
              summary = "Get a list of " + tags[0].toLowerCase();
              break;
            case "show":
              summary = "Get a single instance of " + tags[0].toLowerCase();
              break;
            case "update":
              summary = "Update " + tags[0].toLowerCase();
              break;
            case "destroy":
              summary = "Delete " + tags[0].toLowerCase();
              break;
          }
        }
        let summaryFilePath = sourceFile.replace(this.options.path, "");
        summaryFilePath = summaryFilePath.replace("App/Controllers/Http/", "");
        summaryFilePath = summaryFilePath.replace("/controllers/", "");

        let m = {
          summary:
            sourceFile === "" && action == ""
              ? summary + " (route.ts)"
              : summary + " (" + summaryFilePath + "::" + action + ")",
          description: description,
          operationId: operationId,
          parameters: parameters,
          tags: tags,
          responses: responses,
          security: security,
        };

        if (method !== "GET" && method !== "DELETE") {
          m["requestBody"] = requestBody;
        }

        pattern = pattern.slice(1);
        if (pattern === "") {
          pattern = "/";
        }

        paths = {
          ...paths,
          [pattern]: { ...paths[pattern], [method.toLowerCase()]: m },
        };
      });

      docs.tags = globalTags;
      docs.paths = paths;
    }
    return docs;
  }

  private async getSchemas() {
    let schemas = {
      Any: {
        description: "Any JSON object not defined as schema",
      },
    };

    schemas = {
      ...schemas,
      ...(await this.getInterfaces()),
      ...(await this.getModels()),
    };

    return schemas;
  }

  private async getModels() {
    const models = {};
    let p = path.join(this.options.path, "/Models");
    const p6 = path.join(this.options.path, "/models");
    if (!existsSync(p) && !existsSync(p6)) {
      return models;
    }
    if (existsSync(p6)) {
      p = p6;
    }
    const files = await this.getFiles(p, []);
    const readFile = util.promisify(fs.readFile);
    for (let file of files) {
      const data = await readFile(file, "utf8");
      file = file.replace(".ts", "");
      const split = file.split("/");
      let name = split[split.length - 1].replace(".ts", "");
      file = file.replace("app/", "/app/");
      const parsed = this.parser.parseModelProperties(data);
      if (parsed.name !== "") {
        name = parsed.name;
      }
      let schema = {
        type: "object",
        properties: parsed.props,
        description: "Model",
      };
      models[name] = schema;
    }
    return models;
  }

  private async getInterfaces() {
    let interfaces = {};
    let p = path.join(this.options.path, "/Interfaces");
    const p6 = path.join(this.options.path, "/interfaces");
    if (!existsSync(p) && !existsSync(p6)) {
      return interfaces;
    }
    if (existsSync(p6)) {
      p = p6;
    }
    const files = await this.getFiles(p, []);
    const readFile = util.promisify(fs.readFile);
    for (let file of files) {
      const data = await readFile(file, "utf8");
      file = file.replace(".ts", "");
      const split = file.split("/");
      const name = split[split.length - 1].replace(".ts", "");
      file = file.replace("app/", "/app/");
      interfaces = { ...interfaces, ...this.parser.parseInterfaces(data) };
    }
    return interfaces;
  }

  private async getFiles(dir, files_) {
    const fs = require("fs");
    files_ = files_ || [];
    var files = await fs.readdirSync(dir);
    for (let i in files) {
      var name = dir + "/" + files[i];
      if (fs.statSync(name).isDirectory()) {
        this.getFiles(name, files_);
      } else {
        files_.push(name);
      }
    }
    return files_;
  }
}
