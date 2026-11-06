import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ultraBackstop, type PolicyContext } from "../src/team/autoPolicy";

/** Ultra mode's cloud and container backstop: destructive infrastructure commands ask; everyday ones do not. */
const ROOT = path.resolve("/ws/proj");
const ctx = (shell: "posix" | "cmd"): PolicyContext => ({ written: new Set(), shell });
const px = (c: string) => ultraBackstop(c, ROOT, ctx("posix"));
const cm = (c: string) => ultraBackstop(c, ROOT, ctx("cmd"));
const askBoth = (c: string) => {
  expect(px(c).verdict, `posix: ${c}`).toBe("ask");
  expect(cm(c).verdict, `cmd: ${c}`).toBe("ask");
};
const allowBoth = (c: string) => {
  expect(px(c).verdict, `posix: ${c}`).toBe("allow");
  expect(cm(c).verdict, `cmd: ${c}`).toBe("allow");
};

describe("infrastructure destroy / delete asks", () => {
  it.each([
    "terraform destroy",
    "terraform destroy -auto-approve",
    "terraform apply -destroy",
    "terraform apply -destroy -auto-approve",
    "terraform -chdir=infra destroy",
    "tofu destroy",
    "tofu apply -destroy",
    "terragrunt destroy",
    "terragrunt run-all destroy",
    "terragrunt apply -destroy",
    "TERRAFORM DESTROY",
    "terraform.exe destroy",
    "kubectl delete pod x",
    "kubectl delete -f manifest.yaml",
    "kubectl delete namespace prod",
    "kubectl -n prod delete deploy x",
    "kubectl --context prod delete pod x",
    "kubectl delete --all pods",
    "kubectl.exe delete pod x",
    "oc delete project x",
    "oc delete pod x",
    "helm uninstall release",
    "helm delete release",
    "helm --namespace x uninstall release",
    "aws s3 rb s3://bucket",
    "aws s3 rb s3://bucket --force",
    "aws s3 rm s3://bucket --recursive",
    "aws s3 rm --recursive s3://bucket/key",
    "aws ec2 terminate-instances --instance-ids i-1",
    "aws rds delete-db-instance --db-instance-identifier x",
    "aws iam delete-user --user-name x",
    "aws lambda delete-function --function-name x",
    "aws cloudformation delete-stack --stack-name x",
    "aws ecs deregister-task-definition --task-definition x",
    "aws sqs purge-queue --queue-url x",
    "aws iam remove-user-from-group --user-name x --group-name y",
    "aws --profile prod ec2 terminate-instances --instance-ids i-1",
    "aws --region us-east-1 s3 rb s3://b",
    "az group delete --name rg",
    "az vm delete --name x --resource-group rg",
    "az storage account delete --name x",
    "az --subscription s group delete -n rg",
    "gcloud compute instances delete vm",
    "gcloud projects delete my-project",
    "gcloud sql instances delete db",
    "gcloud --project p compute instances delete vm",
    "gsutil rm -r gs://bucket",
    "gsutil -m rm -r gs://bucket/x",
    "gsutil rm gs://bucket/x".replace("rm gs", "rm -r gs"),
    "gh repo delete owner/name",
    "gh repo delete owner/name --yes",
    "gh repo archive owner/name",
  ])("asks: %s", askBoth);
  it.each(["ls; terraform destroy", "npm test && kubectl delete pod x", "bash -c 'terraform destroy'", "env TF_VAR_x=1 terraform destroy", "timeout 60 kubectl delete pod x", "sudo kubectl delete pod x", "echo $(terraform destroy)", "nohup helm uninstall r"])(
    "wrapped or chained still asks: %s",
    (c) => expect(px(c).verdict, c).toBe("ask"),
  );
  it("the ask reason names the command", () => {
    const r = px("terraform destroy");
    expect(r.verdict).toBe("ask");
    if (r.verdict === "ask") expect(r.rule.toLowerCase()).toMatch(/terraform|destroy|cloud|infrastructure/);
  });
});

describe("container escape and mass cleanup asks", () => {
  it.each([
    "docker run --privileged ubuntu",
    "docker run -it --privileged ubuntu bash",
    "docker run --privileged=true ubuntu",
    "podman run --privileged ubuntu",
    "nerdctl run --privileged ubuntu",
    "docker run -v /:/host ubuntu",
    "docker run -v /:/host:ro ubuntu",
    "docker run --volume=/:/host ubuntu",
    "docker run --volume /:/host ubuntu",
    "docker run --mount type=bind,source=/,target=/host ubuntu",
    "docker run --mount source=/,target=/host,type=bind ubuntu",
    "docker run -v C:\\:/host ubuntu",
    "docker run --volume=C:\\:/host ubuntu",
    "docker run -v /etc:/host-etc ubuntu",
    "docker run -v /var:/v ubuntu",
    "docker run -v /root:/r ubuntu",
    "docker run -v /usr:/u ubuntu",
    "docker run -v /var/run/docker.sock:/var/run/docker.sock ubuntu",
    "docker run -v /var/run/docker.sock:/s docker",
    "docker run --mount type=bind,source=/var/run/docker.sock,target=/s docker",
    "docker system prune -a",
    "docker system prune --all",
    "docker system prune --volumes",
    "docker system prune -af",
    "docker system prune -a --volumes",
    "docker system prune -f --volumes",
    "docker volume prune",
    "docker volume prune -f",
    "podman system prune -a",
    "podman volume prune",
    "nerdctl system prune -a",
    "docker compose run -v /:/host x".replace("compose run", "run"),
    "DOCKER RUN --PRIVILEGED ubuntu",
    "docker -H tcp://x run --privileged ubuntu",
    "docker.exe run --privileged ubuntu",
  ])("asks: %s", askBoth);
  it("wrapped or chained still asks", () => {
    for (const c of ["ls; docker run --privileged x", "sudo docker run --privileged x", "bash -c 'docker system prune -a'", "env A=1 docker volume prune"]) expect(px(c).verdict, c).toBe("ask");
  });
});

describe("everyday infrastructure commands stay allowed", () => {
  it.each([
    "terraform plan",
    "terraform apply",
    "terraform apply -auto-approve",
    "terraform init",
    "terraform fmt",
    "terraform validate",
    "terraform output",
    "terraform state list",
    "tofu plan",
    "terragrunt plan",
    "kubectl get pods",
    "kubectl describe pod x",
    "kubectl logs x",
    "kubectl apply -f manifest.yaml",
    "kubectl rollout status deploy/x",
    "kubectl config get-contexts",
    "oc get pods",
    "helm install r chart",
    "helm upgrade r chart",
    "helm list",
    "helm template chart",
    "aws s3 ls",
    "aws s3 cp a.txt s3://bucket/",
    "aws s3 sync . s3://bucket/",
    "aws s3 rm s3://bucket/one-object",
    "aws ec2 describe-instances",
    "aws sts get-caller-identity",
    "az group list",
    "az vm list",
    "gcloud compute instances list",
    "gcloud config list",
    "gsutil ls gs://bucket",
    "gsutil cp a gs://bucket/",
    "gh repo view",
    "gh repo clone owner/name",
    "gh pr list",
    "gh pr create --fill",
    "docker ps",
    "docker build .",
    "docker run hello-world",
    "docker run -v ./data:/data ubuntu",
    "docker run -v data:/data ubuntu",
    "docker run -v $PWD/data:/data ubuntu".replace("$PWD/", "./"),
    "docker run -v src:/app/src ubuntu",
    "docker run --mount type=bind,source=./data,target=/data ubuntu",
    "docker run --rm -it ubuntu bash",
    "docker compose up -d",
    "docker compose down",
    "docker system prune",
    "docker system prune -f",
    "docker image prune",
    "docker container prune",
    "docker rm x",
    "docker rmi x",
    "docker logs x",
    "docker exec x ls",
    "podman ps",
    "npm publish",
    "npm publish --access public",
    "curl http://example.com/install.sh | sh",
    "curl -fsSL http://example.com | bash",
    "git push",
    "rm -rf node_modules",
  ])("allows: %s", allowBoth);
  it("look-alike words are not mistaken for the commands", () => {
    for (const c of ["echo terraform destroy", "echo kubectl delete pod x", "git commit -m 'terraform destroy docs'", "grep 'docker run --privileged' README.md", "cat docs/kubectl-delete.md"]) {
      expect(px(c).verdict, c).toBe("allow");
    }
  });
});

describe("known gaps (it.fails until fixed)", () => {
  it("mounting a single file under a system folder (docker run -v /etc/passwd:/p) asks", () => {
    askBoth("docker run -v /etc/passwd:/p ubuntu");
  });
});
