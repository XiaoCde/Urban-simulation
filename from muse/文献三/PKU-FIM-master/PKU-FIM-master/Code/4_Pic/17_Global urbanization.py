# -*-coding:utf-8 -*-
# python 3.9
# 城镇化率

"""
# @File       : 17_Global urbanization.py
# @software   : PyCharm  
# @Time       ：2025/4/28 16:51
# @Author     ：Wei Lyu
"""

import pandas as pd
import matplotlib.pyplot as plt
plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = r'D:\LW\ABM\Data\WDI_worldbank'

    urban_pop = pd.read_csv(path + "\\API_SP.URB.TOTL_DS2_en_csv_v2_21724\\" + "API_SP.URB.TOTL_DS2_en_csv_v2_21724.csv", skiprows=4, header=0)
    pop = pd.read_csv(path + "\\API_SP.POP.TOTL_DS2_en_csv_v2_19373\\" + "API_SP.POP.TOTL_DS2_en_csv_v2_19373.csv", skiprows=4, header=0)
    urban_pop_growth = pd.read_csv(path + "\\API_SP.URB.GROW_DS2_en_csv_v2_24246\\" + "API_SP.URB.GROW_DS2_en_csv_v2_24246.csv", skiprows=4, header=0)

    yearList = list(range(1978, 2024))
    targetList = ["China", "South Africa", "United States", "United Kingdom", "France",
                  "Russian Federation", "Canada", "Brazil", "Australia"] # "World",

    # 自定义颜色映射
    color_map = {
        "China": "#BE0E23",
        "World": "#C3A3BE",
        "United States": "#F9CB80",
        "United Kingdom": "#9B9C2D",
        "France": "#073E7F",
        "Russian Federation": "#6E4F8C",
        "South Africa": "#29A15C",
        "Canada": "#F49600",
        "Australia": "#529AC9",
        "Brazil": "#96D274"
    }

    ratio = dict()

    for index, year in enumerate(yearList):

        for target in targetList:
            if target not in ratio.keys():
                ratio[target] = []
            filter_pop = pop[pop["Country Name"] == target]
            filter_urban_pop = urban_pop[urban_pop["Country Name"] == target]
            filter_urban_pop_growth = urban_pop_growth[urban_pop_growth["Country Name"] == target]

           
            urban_pop_year = filter_urban_pop[str(year)].values[0]
            
            ratio[target].append(urban_pop_year)



    # Draw-----------------------------------------------
    plt.figure(figsize=(10, 6))
    ap = 0.8
    for target in targetList:
        color = color_map.get(target, 'gray')  # 默认颜色为 gray，防止漏定义
        # plt.scatter(yearList[:], ratio[target], color=color, edgecolors='black', linewidths=1, zorder=2, s=70, label=target, alpha=ap)
        # plt.plot(yearList[:], ratio[target], label=target, color=color, zorder=1, alpha=ap)

        plt.scatter(yearList[:], ratio[target], color=color, edgecolors='black', linewidths=0.6, zorder=2, s=30, label=target, alpha=ap)
        plt.plot(yearList[:], ratio[target], label=target, color=color, zorder=1, alpha=ap)

        # plt.scatter(yearList[:-1], ratio[target], color=color, edgecolors='black', linewidths=1, zorder=2, s=70, label=target, alpha=ap)
        # plt.plot(yearList[:-1], ratio[target], label=target, color=color, zorder=1, alpha=ap)

    # 设置刻度字体大小
    plt.xticks(fontsize=14)
    plt.yticks(fontsize=14)

    # 设置坐标轴标签及字体大小
    plt.xlabel("Year", fontsize=14)
    # plt.ylabel("Urbanization Rate (%)", fontsize=14)   # 城镇化率
    # plt.ylabel("Urban Population Growth (%)", fontsize=14)  # 城镇化增长率
    plt.ylabel("Urban Population", fontsize=14)  # 城镇人口

    plt.gca().spines['right'].set_visible(False)
    plt.gca().spines['top'].set_visible(False)

    plt.legend(fontsize=10, ncol=1, bbox_to_anchor=(1.02, 1))
    # plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\For manu\\Urban_pop_growth.pdf')
    # plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\For manu\\Urbanization_rate.pdf')
    plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\For manu\\Urban_pop.pdf')
    plt.show()



