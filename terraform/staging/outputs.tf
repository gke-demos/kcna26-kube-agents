output "get_credentials" {
  description = "Commands that add the staging workload cluster to your kubeconfig."
  value = [
    for name, c in google_container_cluster.workload :
    "gcloud container clusters get-credentials ${name} --zone ${c.location} --project ${var.project_id}"
  ]
}
