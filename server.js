import express from "express";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import { createObjectCsvWriter as createCsvWriter } from "csv-writer";

const app = express();
const PORT = 3001;
const PROMETHEUS_URL = "http://localhost:9090/api/v1/query";

const csvWriter = createCsvWriter({
  path: "k8s_metrics.csv",
  header: [
    { id: "podName", title: "Pod Name" },
    { id: "timestamp", title: "Timestamp" },
    { id: "memory_usage", title: "Memory Usage" },
    { id: "network_latency", title: "Network Latency" },
    { id: "packet_loss", title: "Packet Loss" },
    { id: "node_status", title: "Node Status" },
    { id: "disk_io", title: "Disk I/O" },
    { id: "cpu_load", title: "CPU Load" },
    { id: "api_latency", title: "API Latency" },
    { id: "request_errors", title: "Request Errors" },
    { id: "restart_count", title: "Restart Count" }
  ]
});

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout) => {
      if (error) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function getDetailedPodStatus(podName) {
  let terminatedReason = await runCommand(
    `kubectl get pod ${podName} -o jsonpath="{.status.containerStatuses[0].state.terminated.reason}"`
  );
  if (terminatedReason && terminatedReason !== "null" && terminatedReason !== "") {
    return terminatedReason;
  }

  let waitingReason = await runCommand(
    `kubectl get pod ${podName} -o jsonpath="{.status.containerStatuses[0].state.waiting.reason}"`
  );
  if (waitingReason && waitingReason !== "null" && waitingReason !== "") {
    return waitingReason;
  }

  return await runCommand(`kubectl get pod ${podName} -o jsonpath="{.status.phase}"`);
}

async function queryPrometheus(query, timestamp = null) {
  try {
    const timeParam = timestamp ? `&time=${timestamp}` : "";
    const response = await axios.get(`${PROMETHEUS_URL}?query=${encodeURIComponent(query)}${timeParam}`);
    return response.data.data.result.length > 0 ? response.data.data.result[0].value[1] : null;
  } catch (error) {
    return null;
  }
}

// Fetch killed pods and their termination times
async function getKilledPods() {
  const eventsJson = await runCommand(`kubectl get events --sort-by=.lastTimestamp -o json`);
  if (!eventsJson) return [];

  const events = JSON.parse(eventsJson);
  const killedPods = [];

  for (const event of events.items) {
    if (event.reason === "Killing" && event.involvedObject.kind === "Pod") {
      killedPods.push({
        podName: event.involvedObject.name,
        timestamp: new Date(event.lastTimestamp).getTime() / 1000 // Convert to Unix timestamp
      });
    }
  }
  console.log(killedPods)
  return killedPods;
}

async function collectMetrics(deletedpodNames) {
  const timestamp = new Date().toISOString();

  // Get currently running pods
  const podNamesRaw = await runCommand(`kubectl get pods --no-headers -o custom-columns=NAME:.metadata.name`);
  const pods = podNamesRaw ? podNamesRaw.trim().split("\n") : [];


  // Collect metrics for running pods
  for (const podName of pods) {
    if (!podName.startsWith('createpod')) continue;

    const node_status = await getDetailedPodStatus(podName);
    const network_latency = await queryPrometheus(`histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{pod="${podName}"}[1m]))`) || "N/A";
    const packet_loss = await queryPrometheus(`increase(node_network_receive_drop_total{pod="${podName}"}[1m])`) || 0;
    const memory_usage = await queryPrometheus(`container_memory_usage_bytes{pod="${podName}"}`) || 0;
    const cpu_load = await queryPrometheus(`rate(container_cpu_usage_seconds_total{pod="${podName}"}[1m])`) || 0;
    const api_latency = await queryPrometheus(`increase(prometheus_http_request_duration_seconds_count[1m])`) || 0;
    const request_errors = await queryPrometheus(`increase(prometheus_http_requests_total{pod="prometheus-monitoring-kube-prometheus-prometheus-0", code=~"5.."}[1m])`) || 0;
    const disk_io = await queryPrometheus(`increase(node_disk_io_time_seconds_total{pod="${podName}"}[1m])`) || 0;
    let restart_count = await runCommand(`kubectl get pod ${podName} -o jsonpath="{.status.containerStatuses[*].restartCount}"`);
    restart_count = restart_count ? restart_count.trim() : 0;

    const row = { podName, timestamp, memory_usage, network_latency, packet_loss, node_status, disk_io, cpu_load, api_latency, request_errors, restart_count };
    // console.log(row);
    await csvWriter.writeRecords([row]);
    // console.log(`Metrics collected and saved for ${podName}!`);
  }

  // Collect metrics for killed pods
  const killedPods = await getKilledPods();
  for (const { podName, timestamp } of killedPods) {
    if (deletedpodNames.has(podName)) continue;

    const node_status = "Killed";
    const memory_usage = await queryPrometheus(`container_memory_usage_bytes{pod="${podName}"}`, timestamp) || 0;
    const network_latency = await queryPrometheus(`histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{pod="${podName}"}[1m]))`, timestamp) || 0;
    const packet_loss = await queryPrometheus(`increase(node_network_receive_drop_total{pod="${podName}"}[1m])`, timestamp) || 0;
    const cpu_load = await queryPrometheus(`rate(container_cpu_usage_seconds_total{pod="${podName}"}[1m])`, timestamp) || 0;
    const api_latency = await queryPrometheus(`increase(prometheus_http_request_duration_seconds_count[1m])`, timestamp) || 0;
    const request_errors = await queryPrometheus(`increase(prometheus_http_requests_total{pod="prometheus-monitoring-kube-prometheus-prometheus-0", code=~"5.."}[1m])`, timestamp) || 0;
    const disk_io = await queryPrometheus(`increase(node_disk_io_time_seconds_total{pod="${podName}"}[1m])`, timestamp) || 0;
    const restart_count = 0;

    const row = { podName, timestamp: new Date(timestamp * 1000).toISOString(), memory_usage, network_latency, packet_loss, node_status, disk_io, cpu_load, api_latency, request_errors, restart_count };
    // console.log(row);
    deletedpodNames.add(podName);
    await csvWriter.writeRecords([row]);
    // console.log(`Metrics collected and saved for killed pod ${podName}!`);
  }
}

app.listen(PORT, async () => {
  const deletedpodNames = new Set();
  await collectMetrics(deletedpodNames);

  setInterval(async () => {
    await collectMetrics(deletedpodNames);
    // console.log("Metrics collecting");
  }, 5000);

  console.log(`Server running on http://localhost:${PORT}`);
});
