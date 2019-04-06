'use strict';

import { Shell } from '../../../shell';
import { FS } from '../../../fs';
import { ActionResult, fromShellJson, fromShellExitCodeAndStandardError, fromShellExitCodeOnly, Diagnostic } from '../../../wizard';
import { Errorable, failed } from '../../../errorable';
import { sleep } from '../../../sleep';
import { Dictionary } from '../../../utils/dictionary';

export interface Context {
    readonly fs: FS;
    readonly shell: Shell;
}

export interface ServiceLocation {
    readonly displayName: string;
    readonly isPreview: boolean;
}

export interface Locations {
    readonly locations: any;
}

export interface LocationRenderInfo {
    readonly location: string;
    readonly displayText: string;
}

export interface ClusterInfo {
    readonly name: string;
    readonly resourceGroup: string;
}

export interface ConfigureResult {
    readonly clusterType: string;
    readonly gotCli: boolean;
    readonly cliInstallFile: string;
    readonly cliOnDefaultPath: boolean;
    readonly cliError: string;
    readonly gotCredentials: boolean;
    readonly credentialsError: string;
}

export interface WaitResult {
    readonly stillWaiting?: boolean;
}

export async function getProjectList(context: Context): Promise<ActionResult<string[]>> {
    const projects = await listProjectsAsync(context);
    return {
        actionDescription: 'listing projects',
        result: projects
    };
}

async function listProjectsAsync(context: Context): Promise<Errorable<string[]>> {
    const sr = await context.shell.exec("gcloud projects list");

    return fromShellJson<string[]>(sr, "Unable to list Google projects");
}

export async function setProjectAsync(context: Context, project: string): Promise<Errorable<Diagnostic>> {
   const sr = await context.shell.exec(`gcloud config set project "${project}"`);

    return fromShellExitCodeAndStandardError(sr, "Unable to set gcloud CLI project");
}

export async function getClusterList(context: Context, project: string): Promise<ActionResult<ClusterInfo[]>> {
    // log in
    const login = await setProjectAsync(context, project);
    if (failed(login)) {
        return {
            actionDescription: 'logging into project',
            result: { succeeded: false, error: login.error }
        };
    }

    // list clusters
    const clusters = await listClustersAsync(context);
    return {
        actionDescription: 'listing clusters',
        result: clusters
    };
}

async function listClustersAsync(context: Context): Promise<Errorable<ClusterInfo[]>> {
    const sr = await context.shell.exec('gcloud container clusters list');

    return fromShellJson<ClusterInfo[]>(sr, "Unable to list Kubernetes clusters");
}

async function listLocations(context: Context): Promise<Errorable<Locations>> {
    let query = "[].{name:name,displayName:displayName}";
    if (context.shell.isUnix()) {
        query = `'${query}'`;
    }

    const sr = await context.shell.exec(`az account list-locations --query ${query} -ojson`);

    return fromShellJson<Locations>(sr, "Unable to list Google regions", (response) => {
        /* tslint:disable-next-line:prefer-const */
        let locations = Dictionary.of<string>();
        for (const r of response) {
            locations[r.name] = r.displayName;
        }
        return { locations: locations };
    });
}

export async function listGkeLocations(context: Context): Promise<Errorable<ServiceLocation[]>> {
    const locationInfo = await listLocations(context);
    if (failed(locationInfo)) {
        return { succeeded: false, error: locationInfo.error };
    }
    const locations = locationInfo.result;

    // There's no CLI for this, so we have to hardwire it for now
    const productionRegions = [
        "australiaeast",
        "australiasoutheast",
        "canadacentral",
        "canadaeast",
        "centralindia",
        "centralus",
        "eastasia",
        "eastus",
        "eastus2",
        "francecentral",
        "japaneast",
        "northeurope",
        "southeastasia",
        "southindia",
        "uksouth",
        "ukwest",
        "westeurope",
        "westus",
        "westus2",
    ];
    const result = locationDisplayNamesEx(productionRegions, [], locations);
    return { succeeded: true, result: result };
}

function locationDisplayNames(names: string[], preview: boolean, locationInfo: Locations): ServiceLocation[] {
    return names.map((n) => { return { displayName: locationInfo.locations[n], isPreview: preview }; });
}

function locationDisplayNamesEx(production: string[], preview: string[], locationInfo: Locations): ServiceLocation[] {
    let result = locationDisplayNames(production, false, locationInfo) ;
    result = result.concat(locationDisplayNames(preview, true, locationInfo));
    return result;
}

export async function listVMSizes(context: Context, location: string): Promise<Errorable<string[]>> {
    const sr = await context.shell.exec(`az vm list-sizes -l "${location}" -ojson`);

    return fromShellJson<string[]>(sr,
        "Unable to list VM sizes",
        (response: any[]) => response.map((r) => r.name as string)
                                      .filter((name) => !name.startsWith('Basic_'))
    );
}

async function execCreateClusterCmd(context: Context, options: any): Promise<Errorable<Diagnostic>> {
    let createCmd = `gcloud container clusters create "${options.metadata.clusterName}" --zone "${options.metadata.location}" --async `;

    const sr = await context.shell.exec(createCmd);

    return fromShellExitCodeOnly(sr, "Unable to call Gcloud CLI to create cluster");
}

export async function createCluster(context: Context, options: any): Promise<ActionResult<Diagnostic>> {
    const login = await setProjectAsync(context, options.project);
    if (!login.succeeded) {
        return {
            actionDescription: 'logging into project',
            result: login
        };
    }

    const createCluster = await execCreateClusterCmd(context, options);

    return {
        actionDescription: 'creating cluster',
        result: createCluster
    };
}

function wait(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

export async function waitForCluster(context: Context, clusterName: string): Promise<Errorable<WaitResult>> {
    // TODO: figure out how to wait for real...
    await wait(300 * 1000);
    return { succeeded: true, result: { stillWaiting: false } };
}

export async function configureCluster(context: Context, clusterType: string, clusterName: string): Promise<ActionResult<ConfigureResult>> {
    const getCredentialsPromise = getCredentials(context, clusterName, 5);

    const credsResult = await getCredentialsPromise;

    const result = {
        clusterType: clusterType,
        gotCredentials: credsResult.succeeded,
        credentialsError: credsResult.error
    };

    return {
        actionDescription: 'configuring Kubernetes',
        result: { succeeded: credsResult.succeeded, result: result, error: [] }  // TODO: this ends up not fitting our structure very well - fix?
    };
}

async function getCredentials(context: Context, clusterName: string, maxAttempts: number): Promise<any> {
    // const kubeconfig = getActiveKubeconfig();
    // TODO const kubeconfigFileOption = kubeconfig ? `-f "${kubeconfig}"` : '';
    let attempts = 0;
    while (true) {
        attempts++;
        const cmd = `gcloud container clusters get-credentials ${clusterName}`;
        const sr = await context.shell.exec(cmd);

        if (sr && sr.code === 0 && !sr.stderr) {
            return {
                succeeded: true
            };
        } else if (attempts < maxAttempts) {
            await sleep(15000);
        } else {
            return {
                succeeded: false,
                error: sr ? sr.stderr : "Unable to invoke gcloud CLI"
            };
        }
    }
}

