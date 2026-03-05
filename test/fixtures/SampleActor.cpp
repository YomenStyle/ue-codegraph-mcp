#include "SampleActor.h"
#include "Components/StaticMeshComponent.h"
#include "Kismet/GameplayStatics.h"

ASampleActor::ASampleActor()
{
    PrimaryActorTick.bCanEverTick = true;
    MaxHealth = 100.0f;
    CurrentHealth = MaxHealth;
    bIsDead = false;
}

void ASampleActor::BeginPlay()
{
    Super::BeginPlay();
    CurrentHealth = MaxHealth;
    NotifyHealthChanged();
}

void ASampleActor::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
}

void ASampleActor::TakeDamage(float DamageAmount)
{
    if (bIsDead) return;

    CurrentHealth = FMath::Clamp(CurrentHealth - DamageAmount, 0.0f, MaxHealth);
    NotifyHealthChanged();
    UpdateHealthUI();

    if (CurrentHealth <= 0.0f)
    {
        bIsDead = true;
        OnDeath();
    }
}

float ASampleActor::GetHealth() const
{
    return CurrentHealth;
}

void ASampleActor::ApplyEffect_Implementation(const FString& EffectName, float Duration)
{
    UE_LOG(LogTemp, Log, TEXT("Applying effect: %s for %f seconds"), *EffectName, Duration);
}

void ASampleActor::UpdateHealthUI()
{
    // Update UI elements
}

void ASampleActor::NotifyHealthChanged()
{
    OnHealthChanged.Broadcast(CurrentHealth);
}
