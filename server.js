import express from "express";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import { createObjectCsvWriter as createCsvWriter } from "csv-writer";

const app = express();
const PORT = 3000;
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
    { id: "request_errors", title: "Request Errors" }
  ]
});

// Function to execute shell commands
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

// Function to query Prometheus
async function queryPrometheus(query) {
  try {
    const response = await axios.get(`http://localhost:9090/api/v1/query?query=${encodeURIComponent(query)}`);
    console.log(response.data)
    return response.data.data.result.length > 0 ? response.data.data.result[0].value[1] : null;
  } catch (error) {
    return null;
  }
}

async function collectMetrics() {
  const timestamp = new Date().toISOString();
  const podNames = await runCommand(`kubectl get pods --no-headers -o custom-columns=NAME:.metadata.name`);
  const pods = podNames.split('\n');
  for (const podName of pods) {
    if(podName.split("-")[0]!='createpod')   continue; 

    const network_latency = await queryPrometheus(`histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{pod="${podName}"}[1m]))`);
    const packet_loss = await queryPrometheus(`increase(node_network_receive_drop_total{pod="${podName}"}[1m])`);
    const memory_usage = await queryPrometheus(`avg_over_time(container_memory_usage_bytes{pod="${podName}"}[1m])`);               // done 
    const cpu_load = await queryPrometheus(`rate(container_cpu_usage_seconds_total{pod="${podName}"}[1m])`);                      
    const api_latency = await queryPrometheus(`increase(prometheus_http_request_duration_seconds_count[1m])`);     
    const request_errors = await queryPrometheus(`increase(prometheus_http_requests_total{pod="prometheus-monitoring-kube-prometheus-prometheus-0" , code=~"5.."}[1m])`); // done
    const node_status = await runCommand(`kubectl get pod ${podName} -o jsonpath='{.status.phase}'`);                             //done
    const disk_io = await queryPrometheus(`increase(node_disk_io_time_seconds_total{pod="${podName}"}[1m])`); // done
    const row = {
      podName,
      timestamp,
      memory_usage,
      network_latency,
      packet_loss,
      node_status,
      disk_io,
      cpu_load,
      api_latency,
      request_errors
    };
    console.log(row);
    await csvWriter.writeRecords([row]);
    console.log("Metrics collected and saved!");
  }

}


// app.get("/keepcollecting-metrics", (req, res) => {
//   const interval = setInterval(async () => {
//     await getAllPods();
//     console.log("Metrics collecting");
//   }, 60000);

//   res.send("Scheduled continuous metric collection.");
// })


app.listen(PORT, async () => {
  await collectMetrics();
  const interval = setInterval(async () => {
    await collectMetrics();
    console.log("Metrics collecting");
  }, 1000);
  console.log(`Server running on http://localhost:${PORT}`);
});
